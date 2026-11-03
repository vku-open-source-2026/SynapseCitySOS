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

export type V1Boundary = 'owned' | 'foreign' | 'unknown';

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
// strip trailing slashes before classifying the path. This closes encoded,
// uppercase and trailing-slash attempts to smuggle a City namespace past the
// SOS boundary.
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

// Preserve segment case for upstream ids while decoding `/%76%31/...` and
// resolving dot segments. The gateway proxies this canonical target instead of
// the raw URL, so Express mounts in the service match an encoded `/v1` prefix.
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

export function createApp(options: GatewayOptions = {}): express.Express {
  const app = express();
  const UPSTREAM = assertUpstream(options.upstream ?? process.env.SOS_SERVICE_URL ?? 'http://sos-service:8084');
  const CONSOLE = assertUpstream(options.consoleUpstream ?? process.env.CONSOLE_URL ?? 'http://console:80');
  const CORS_ORIGIN = options.corsOrigin ?? process.env.CORS_ORIGIN ?? 'https://sos.synapsecity.sbs';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', CORS_ORIGIN);
    res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
    next();
  });

  async function proxy(req: Request, res: Response, target: string): Promise<void> {
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {
      'content-type': req.header('content-type') || 'application/json',
      'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID(),
    };
    for (const name of ['authorization', 'x-api-key', 'x-correlation-id']) {
      const value = req.header(name);
      if (value) headers[name] = value;
    }
    const response = await fetch(`${UPSTREAM}${target}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
    });
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && response.body) {
      res.status(response.status).setHeader('content-type', contentType);
      res.setHeader('cache-control', response.headers.get('cache-control') || 'no-cache');
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
    if (response.status === 204 || response.status === 304) {
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
      const response = await fetch(`${UPSTREAM}${path}`);
      const body = await response.text();
      res.status(response.ok ? 200 : 503).type('json').send(JSON.stringify({
        status: response.ok ? (path === '/ready' ? 'ready' : 'ok') : 'degraded',
        service: 'synapsecity-sos-gateway',
        upstream: JSON.parse(body),
      }));
    } catch (error) {
      res.status(503).json({ status: 'degraded', service: 'synapsecity-sos-gateway', error: (error as Error).message });
    }
  }

  app.get('/health', (_req, res) => { health('/health', res).catch(() => undefined); });
  app.get('/ready', (_req, res) => { health('/ready', res).catch(() => undefined); });
  app.use((req, res, next) => {
    const path = normalizeV1Path(req.originalUrl);
    if (path !== '/v1' && !path.startsWith('/v1/')) return next();
    if (classifyV1Path(req.originalUrl) !== 'owned') {
      // Foreign or unknown /v1 namespace: answer at the edge, never proxy it.
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    const target = canonicalApiUrl(req.originalUrl);
    if (!target || (target !== '/v1' && !target.startsWith('/v1/'))) {
      res.status(404).json(NOT_FOUND_BODY);
      return;
    }
    // Proxy the canonical decoded path so `/%76%31/...` reaches the service's
    // `/v1` mount instead of falling through to the console SPA.
    proxy(req, res, target).catch(next);
  });
  app.use(async (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) return next();
    try {
      const response = await fetch(`${CONSOLE}${req.originalUrl}`, { method: req.method, headers: { accept: req.header('accept') || 'text/html' } });
      res.status(response.status);
      const contentType = response.headers.get('content-type');
      if (contentType) res.setHeader('content-type', contentType);
      res.send(await response.text());
    } catch (error) { next(error); }
  });
  app.use((error: Error, _req: Request, res: Response, _next: unknown) => res.status(502).json({ error: 'sos_upstream_unavailable', message: error.message }));
  return app;
}

const app = createApp();

if (require.main === module) app.listen(Number(process.env.PORT || 8080), () => console.log(`[synapsecity-sos-gateway] listening on :${process.env.PORT || 8080}`));
export { app };
