// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

// SynapseCitySOS owns emergency operations only. SynapseCity (a separate
// product at https://synapsecity.sbs) owns every city-infrastructure
// namespace. Reject both foreign and unknown /v1 paths here, before any
// upstream call, so the SOS edge can never proxy city traffic.
const BOUNDARY_PRODUCT = 'synapsecity-sos';
const OWNED_V1_PREFIXES: readonly string[] = [
  '/v1/sos',
  '/v1/auth',
  '/v1/emergency',
  '/v1/hazards',
  '/v1/geo',
  '/v1/map',
  '/v1/ai',
];
const FOREIGN_V1_PREFIXES: readonly string[] = [
  '/v1/assets',
  '/v1/incidents',
  '/v1/maintenance',
  '/v1/iot',
  '/v1/alerts',
  '/v1/budgets',
  '/v1/reports',
  '/v1/notifications',
  '/v1/users',
  '/v1/geofences',
  '/v1/ingest',
  '/v1/city',
  '/v1/public/assets',
  '/v1/public/incidents',
];
const NOT_FOUND_BODY = { error: 'not_found', product: BOUNDARY_PRODUCT } as const;
const DEFAULT_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS || 10_000);
const DEFAULT_CONSOLE_TIMEOUT_MS = Number(process.env.GATEWAY_CONSOLE_TIMEOUT_MS || 15_000);

export type V1Boundary = 'owned' | 'foreign' | 'unknown';

export class GatewayTimeoutError extends Error {
  readonly code = 'upstream_timeout';
  constructor(target: string, timeoutMs: number) {
    super(`${target} did not respond within ${timeoutMs}ms`);
    this.name = 'GatewayTimeoutError';
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, target: string): Promise<Awaited<ReturnType<typeof fetch>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new GatewayTimeoutError(target, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read an upstream response as raw bytes. `response.text()` must never be used
 * for proxying: it decodes binary payloads (PNG/PDF/octet-stream) as UTF-8 and
 * corrupts them.
 */
export async function proxyResponseBody(response: Awaited<ReturnType<typeof fetch>>): Promise<Buffer> {
  if (response.status === 204 || response.status === 304) return Buffer.alloc(0);
  return Buffer.from(await response.arrayBuffer());
}

export interface GatewayOptions {
  upstream?: string;
  consoleUpstream?: string;
  corsOrigin?: string;
  timeoutMs?: number;
  consoleTimeoutMs?: number;
}

function decodedPath(value: string): string | null {
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return current;
      current = decoded;
    } catch { return null; }
  }
  return current;
}

// Decode, resolve dot segments, collapse duplicate separators, lowercase and
// strip trailing slashes before classifying the path.
export function normalizeV1Path(raw: string): string {
  const withoutQuery = (raw.split('?')[0] || '/').split('#')[0];
  const decoded = decodedPath(withoutQuery);
  if (decoded === null) return '/__invalid_path__';
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment.toLowerCase());
  }
  return `/${segments.join('/')}`;
}

export function canonicalApiUrl(raw: string): string | null {
  const [rawPath, query] = raw.split('?');
  const value = rawPath || '/';
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch { return null; }
  }
  const segments: string[] = [];
  for (const segment of current.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment);
  }
  const path = `/${segments.join('/')}`;
  return query ? `${path}?${query}` : path;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function classifyV1Path(raw: string): V1Boundary {
  const path = normalizeV1Path(raw);
  if (OWNED_V1_PREFIXES.some((prefix) => within(path, prefix))) return 'owned';
  if (FOREIGN_V1_PREFIXES.some((prefix) => within(path, prefix))) return 'foreign';
  return 'unknown';
}

function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`SOS_SERVICE_URL is not an absolute URL: ${value}`); }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)) throw new Error('SOS_SERVICE_URL may not point to localhost');
  return value.replace(/\/$/, '');
}

interface GatewayMetric {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}
const metrics = new Map<string, GatewayMetric>();

function recordMetric(route: string, durationMs: number, status: number): void {
  const metric = metrics.get(route) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  if (status >= 500) metric.errors += 1;
  metrics.set(route, metric);
}

function renderMetrics(): string {
  const lines = [
    '# HELP sos_gateway_request_total Total gateway requests.',
    '# TYPE sos_gateway_request_total counter',
    '# HELP sos_gateway_request_errors_total Total gateway 5xx responses.',
    '# TYPE sos_gateway_request_errors_total counter',
    '# HELP sos_gateway_request_duration_ms_sum Cumulative gateway request duration.',
    '# TYPE sos_gateway_request_duration_ms_sum counter',
  ];
  for (const [route, metric] of metrics) {
    const label = route.replace(/[^a-zA-Z0-9_./{}-]/g, '_');
    lines.push(`sos_gateway_request_total{route="${label}"} ${metric.count}`);
    lines.push(`sos_gateway_request_errors_total{route="${label}"} ${metric.errors}`);
    lines.push(`sos_gateway_request_duration_ms_sum{route="${label}"} ${Math.round(metric.totalMs)}`);
  }
  return `${lines.join('\n')}\n`;
}

function routeLabel(req: Request): string {
  const path = (req.originalUrl.split('?')[0] || '/').replace(/\/[0-9a-f]{8,}/gi, '/{id}');
  const segments = path.split('/');
  return segments.length > 4 ? `${segments.slice(0, 4).join('/')}/*` : path;
}

export function createApp(options: GatewayOptions = {}): express.Express {
  const app = express();
  const UPSTREAM = assertUpstream(options.upstream ?? process.env.SOS_SERVICE_URL ?? 'http://sos-service:8084');
  const CONSOLE = assertUpstream(options.consoleUpstream ?? process.env.CONSOLE_URL ?? 'http://console:80');
  const CORS_ORIGIN = options.corsOrigin ?? process.env.CORS_ORIGIN ?? 'https://sos.synapsecity.sbs';
  const TIMEOUT_MS = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const CONSOLE_TIMEOUT_MS = options.consoleTimeoutMs ?? DEFAULT_CONSOLE_TIMEOUT_MS;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', CORS_ORIGIN);
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id,if-match,if-none-match,last-event-id');
    res.setHeader('access-control-expose-headers', 'etag,x-record-version,x-sos-scan-truncated,location,retry-after,x-correlation-id');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.method === 'OPTIONS') return res.status(204).end();
    res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
    const start = process.hrtime.bigint();
    const label = routeLabel(req);
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      recordMetric(label, durationMs, res.statusCode);
      console.log(JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : 'info',
        service: 'synapsecity-sos-gateway',
        msg: 'request',
        method: req.method,
        path: label,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        correlation_id: res.getHeader('x-correlation-id')?.toString(),
      }));
    });
    next();
  });

  async function proxy(req: Request, res: Response, target: string): Promise<void> {
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {
      'content-type': req.header('content-type') || 'application/json',
      'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID(),
    };
    for (const name of ['authorization', 'x-api-key', 'accept', 'if-match', 'if-none-match', 'last-event-id']) {
      const value = req.header(name);
      if (value) headers[name] = value;
    }
    const response = await fetchWithTimeout(`${UPSTREAM}${target}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
    }, TIMEOUT_MS, 'sos-service');
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && response.body) {
      res.status(response.status).setHeader('content-type', contentType);
      res.setHeader('cache-control', response.headers.get('cache-control') || 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          res.write(Buffer.from(chunk.value));
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }
    const cacheControl = response.headers.get('cache-control');
    res.status(response.status);
    if (contentType) res.setHeader('content-type', contentType);
    if (cacheControl) res.setHeader('cache-control', cacheControl);
    // Forward the conditional-write/record-version headers so Tier-3 clients
    // keep ETag/If-Match semantics through the edge (issue #20).
    for (const name of ['etag', 'x-record-version', 'x-sos-scan-truncated', 'location', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (method === 'HEAD' || response.status === 204 || response.status === 304) {
      res.end();
      return;
    }
    // Preserve the upstream bytes. response.text() corrupts binary payloads
    // such as VietMap PNG tiles (0x89 becomes the UTF-8 replacement sequence).
    const body = await proxyResponseBody(response);
    res.setHeader('content-length', String(body.length));
    res.end(body);
  }

  async function health(path: '/health' | '/ready', res: Response): Promise<void> {
    try {
      const response = await fetchWithTimeout(`${UPSTREAM}${path}`, {}, TIMEOUT_MS, 'sos-service');
      const text = await response.text();
      let upstream: unknown = text;
      try { upstream = JSON.parse(text); } catch { /* keep the raw text */ }
      res.status(response.ok ? 200 : 503).type('json').send(JSON.stringify({
        status: response.ok ? (path === '/ready' ? 'ready' : 'ok') : 'degraded',
        service: 'synapsecity-sos-gateway',
        upstream,
      }));
    } catch (error) {
      const timeout = error instanceof GatewayTimeoutError;
      res.status(timeout ? 504 : 503).json({
        status: 'degraded',
        service: 'synapsecity-sos-gateway',
        error: timeout ? 'upstream_timeout' : (error as Error).message,
      });
    }
  }

  app.get('/health', (_req, res) => { health('/health', res).catch(() => undefined); });
  app.get('/ready', (_req, res) => { health('/ready', res).catch(() => undefined); });
  app.get('/metrics', (_req, res) => { res.type('text/plain; version=0.0.4').send(renderMetrics()); });

  app.use((req, res, next) => {
    const path = normalizeV1Path(req.originalUrl);
    if (path !== '/v1' && !path.startsWith('/v1/')) return next();
    if (classifyV1Path(req.originalUrl) !== 'owned') {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    const target = canonicalApiUrl(req.originalUrl);
    if (!target || (target !== '/v1' && !target.startsWith('/v1/'))) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    proxy(req, res, target).catch(next);
  });

  app.use(async (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) return next();
    try {
      const response = await fetchWithTimeout(`${CONSOLE}${req.originalUrl}`, {
        method: req.method,
        headers: { accept: req.header('accept') || 'text/html' },
      }, CONSOLE_TIMEOUT_MS, 'console');
      const contentType = response.headers.get('content-type') || '';
      res.status(response.status);
      if (contentType) res.setHeader('content-type', contentType);
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method.toUpperCase() === 'HEAD') {
        res.end();
        return;
      }
      const body = await proxyResponseBody(response);
      res.setHeader('content-length', String(body.length));
      res.end(body);
    } catch (error) { next(error); }
  });

  app.use((error: Error, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof GatewayTimeoutError) {
      res.status(504).json({ error: 'upstream_timeout', message: error.message });
      return;
    }
    res.status(502).json({ error: 'sos_upstream_unavailable', message: error.message });
  });
  return app;
}

const app = createApp();

if (require.main === module) app.listen(Number(process.env.PORT || 8080), () => console.log(`[synapsecity-sos-gateway] listening on :${process.env.PORT || 8080}`));
export { app };
