// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const upstream = (process.env.SOS_SERVICE_URL || 'http://sos-service:8084').replace(/\/$/, '');
const consoleUpstream = (process.env.CONSOLE_URL || 'http://console:80').replace(/\/$/, '');

function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`SOS_SERVICE_URL is not an absolute URL: ${value}`); }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)) throw new Error('SOS_SERVICE_URL may not point to localhost');
  return value.replace(/\/$/, '');
}

const UPSTREAM = assertUpstream(upstream);
const CONSOLE = assertUpstream(consoleUpstream);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || 'https://synapsecity.sbs');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  next();
});

async function proxy(req: Request, res: Response): Promise<void> {
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = {
    'content-type': req.header('content-type') || 'application/json',
    'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID(),
  };
  for (const name of ['authorization', 'x-api-key', 'x-correlation-id']) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  const response = await fetch(`${UPSTREAM}${req.originalUrl}`, {
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
  const text = await response.text();
  res.status(response.status);
  if (contentType) res.setHeader('content-type', contentType);
  res.send(text);
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
app.use('/v1', (req, res, next) => { proxy(req, res).catch(next); });
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

if (require.main === module) app.listen(PORT, () => console.log(`[synapsecity-sos-gateway] listening on :${PORT}; upstream=${UPSTREAM}; console=${CONSOLE}`));
export { app };
