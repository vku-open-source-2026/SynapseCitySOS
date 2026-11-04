// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app, canonicalApiUrl, classifyV1Path, createApp, normalizeV1Path, proxyResponseBody } from './index';

const NOT_FOUND = { error: 'not_found', product: 'synapsecity-sos' };

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('foreign SynapseCity namespaces return the exact 404 body without an upstream', async () => {
  const foreignPaths = [
    '/v1/assets',
    '/v1/assets/asset-1',
    '/v1/incidents',
    '/v1/incidents/incident-1',
    '/v1/maintenance',
    '/v1/iot/sensors',
    '/v1/alerts',
    '/v1/budgets',
    '/v1/reports',
    '/v1/notifications',
    '/v1/users',
    '/v1/geofences',
    '/v1/ingest',
    '/v1/city',
    '/v1/public/assets',
    '/v1/public/assets/asset-1',
    '/v1/public/incidents',
  ];

  for (const path of foreignPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must be rejected at the SOS edge`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the SOS not-found body`);
  }
});

test('unknown /v1 namespaces are rejected before the SOS proxy', async () => {
  for (const path of ['/v1', '/v1/unknown', '/v1/public/unknown', '/v1/admin']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must be rejected at the SOS edge`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the SOS not-found body`);
  }
});

test('encoded, uppercase and trailing-slash variants cannot bypass the boundary', async () => {
  const bypasses = [
    '/v1/ASSETS',
    '/v1/Assets/',
    '/v1/%61ssets',
    '/v1/incidents%2F1',
    '/v1/public/%61ssets',
    '/v1/city/',
    '/v1/%63ity',
    '/v1/users/',
    '/%76%31/assets',
  ];

  for (const path of bypasses) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not bypass the SOS boundary`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the SOS not-found body`);
  }
});

test('owned SOS paths classify as owned without a live upstream', () => {
  assert.equal(normalizeV1Path('/v1/EMERGENCY/eop/'), '/v1/emergency/eop');
  assert.equal(normalizeV1Path('/v1/hazards/../emergency'), '/v1/emergency');

  for (const owned of [
    '/v1/sos',
    '/v1/auth/login',
    '/v1/emergency',
    '/v1/emergency/eop',
    '/v1/emergency/dispatch',
    '/v1/emergency/resources',
    '/v1/emergency/sitrep',
    '/v1/emergency/after-action',
    '/v1/emergency/stream/hazards',
    '/v1/hazards',
    '/v1/hazards/recent',
    '/v1/geo/search-address',
    '/v1/map/config',
    '/v1/ai/chat',
    '/v1/EMERGENCY/',
    '/%76%31/emergency',
  ]) {
    assert.equal(classifyV1Path(owned), 'owned', `${owned} belongs to SynapseCitySOS`);
  }

  for (const foreign of ['/v1/assets', '/v1/incidents/1', '/v1/public/assets', '/v1/city', '/%76%31/assets']) {
    assert.equal(classifyV1Path(foreign), 'foreign', `${foreign} belongs to SynapseCity`);
  }
  for (const unknown of ['/v1', '/v1/unknown', '/v1/public/other']) {
    assert.equal(classifyV1Path(unknown), 'unknown', `${unknown} is not part of the SOS contract`);
  }
});

test('canonicalApiUrl decodes the /v1 prefix while preserving path case and query', () => {
  assert.equal(canonicalApiUrl('/%76%31/emergency'), '/v1/emergency');
  assert.equal(canonicalApiUrl('/%76%31/EMERGENCY/eop/?limit=5'), '/v1/EMERGENCY/eop?limit=5');
  assert.equal(canonicalApiUrl('/v1/assets/../emergency'), '/v1/emergency');
  assert.equal(canonicalApiUrl('/%76%31/%61ssets'), '/v1/assets');
  assert.equal(canonicalApiUrl('/%zz'), null);
});

test('encoded owned /v1 paths are proxied as JSON and never fall through to the SPA', async () => {
  const fakeUpstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ upstreamPath: req.url }));
  });
  await new Promise<void>((resolve) => fakeUpstream.listen(0, '0.0.0.0', resolve));
  const upstreamPort = (fakeUpstream.address() as AddressInfo).port;
  const fakeConsole = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>console</body></html>');
  });
  await new Promise<void>((resolve) => fakeConsole.listen(0, '0.0.0.0', resolve));
  const consolePort = (fakeConsole.address() as AddressInfo).port;

  const encodedApp = createApp({
    upstream: `http://0.0.0.0:${upstreamPort}`,
    consoleUpstream: `http://0.0.0.0:${consolePort}`,
  });
  const encodedServer = encodedApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    encodedServer.once('listening', resolve);
    encodedServer.once('error', reject);
  });
  const encodedBase = `http://127.0.0.1:${(encodedServer.address() as AddressInfo).port}`;

  try {
    for (const [path, upstreamPath] of [
      ['/%76%31/emergency', '/v1/emergency'],
      ['/%76%31/hazards', '/v1/hazards'],
      ['/%76%31/sos', '/v1/sos'],
      ['/%76%31/auth/login', '/v1/auth/login'],
    ]) {
      const response = await fetch(`${encodedBase}${path}`);
      assert.equal(response.status, 200, `${path} must be proxied`);
      assert.match(response.headers.get('content-type') || '', /application\/json/);
      assert.deepEqual(await response.json(), { upstreamPath }, `${path} must reach the canonical API path`);
    }

    const foreign = await fetch(`${encodedBase}/%76%31/assets`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), NOT_FOUND);

    const unknown = await fetch(`${encodedBase}/%76%31/unknown`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), NOT_FOUND);
  } finally {
    await new Promise<void>((resolve) => encodedServer.close(() => resolve()));
    await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
    await new Promise<void>((resolve) => fakeConsole.close(() => resolve()));
  }
});

test('binary upstream payloads are proxied byte-for-byte', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const response = new Response(png, { headers: { 'content-type': 'image/png' } });
  const body = await proxyResponseBody(response);
  assert.equal(body[0], 0x89, 'PNG signature must not become a UTF-8 replacement character');
  assert.deepEqual([...body], [...png]);
});

test('CORS advertises PUT and DELETE for the SOS API', async () => {
  const response = await fetch(`${baseUrl}/v1/sos`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  const methods = response.headers.get('access-control-allow-methods') || '';
  assert.match(methods, /\bPUT\b/);
  assert.match(methods, /\bDELETE\b/);
});

test('an upstream that exceeds the timeout returns 504 instead of hanging', async () => {
  const slowUpstream = createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }, 500);
  });
  await new Promise<void>((resolve) => slowUpstream.listen(0, '0.0.0.0', resolve));
  const upstreamPort = (slowUpstream.address() as AddressInfo).port;
  const fakeConsole = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>console</body></html>');
  });
  await new Promise<void>((resolve) => fakeConsole.listen(0, '0.0.0.0', resolve));
  const consolePort = (fakeConsole.address() as AddressInfo).port;

  const slowApp = createApp({
    upstream: `http://0.0.0.0:${upstreamPort}`,
    consoleUpstream: `http://0.0.0.0:${consolePort}`,
    timeoutMs: 50,
    consoleTimeoutMs: 50,
  });
  const slowServer = slowApp.listen(0);
  await new Promise<void>((resolve, reject) => {
    slowServer.once('listening', resolve);
    slowServer.once('error', reject);
  });
  const slowBase = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${slowBase}/v1/emergency`);
    assert.equal(response.status, 504);
    const body = await response.json() as { error: string };
    assert.equal(body.error, 'upstream_timeout');

    const health = await fetch(`${slowBase}/health`);
    assert.equal(health.status, 504);
  } finally {
    await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    await new Promise<void>((resolve) => slowUpstream.close(() => resolve()));
    await new Promise<void>((resolve) => fakeConsole.close(() => resolve()));
  }
});

test('the console proxy preserves binary bytes and handles HEAD without a body', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x80]);
  const fakeConsole = createServer((req, res) => {
    if (req.url === '/icons/icon-192x192.png') {
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from(png));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>console</body></html>');
  });
  await new Promise<void>((resolve) => fakeConsole.listen(0, '0.0.0.0', resolve));
  const consolePort = (fakeConsole.address() as AddressInfo).port;
  const fakeUpstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => fakeUpstream.listen(0, '0.0.0.0', resolve));
  const upstreamPort = (fakeUpstream.address() as AddressInfo).port;

  const app = createApp({
    upstream: `http://0.0.0.0:${upstreamPort}`,
    consoleUpstream: `http://0.0.0.0:${consolePort}`,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const image = await fetch(`${base}/icons/icon-192x192.png`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') || '', /image\/png/);
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [...png]);

    const head = await fetch(`${base}/icons/icon-192x192.png`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fakeConsole.close(() => resolve()));
    await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
  }
});

test('conditional-write, record-version and stream-resume headers survive the edge (issue #20)', async () => {
  const seen: Record<string, string | string[] | undefined> = {};
  const fakeUpstream = createServer((req, res) => {
    seen['if-match'] = req.headers['if-match'];
    seen['if-none-match'] = req.headers['if-none-match'];
    seen['last-event-id'] = req.headers['last-event-id'];
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('etag', '"7"');
    res.setHeader('x-record-version', '7');
    res.end(JSON.stringify({ id: 'plan-1', record_version: 7 }));
  });
  await new Promise<void>((resolve) => fakeUpstream.listen(0, '0.0.0.0', resolve));
  const upstreamPort = (fakeUpstream.address() as AddressInfo).port;
  const fakeConsole = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><body>console</body></html>');
  });
  await new Promise<void>((resolve) => fakeConsole.listen(0, '0.0.0.0', resolve));
  const consolePort = (fakeConsole.address() as AddressInfo).port;

  const app = createApp({
    upstream: `http://0.0.0.0:${upstreamPort}`,
    consoleUpstream: `http://0.0.0.0:${consolePort}`,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const updated = await fetch(`${base}/v1/emergency/eop/plan-1/markdown`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"7"', 'if-none-match': '"6"' },
      body: JSON.stringify({ markdown_body: '# x' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(seen['if-match'], '"7"', 'If-Match must reach sos-service');
    assert.equal(seen['if-none-match'], '"6"');
    assert.equal(updated.headers.get('etag'), '"7"', 'the record ETag must reach the client');
    assert.equal(updated.headers.get('x-record-version'), '7');

    const stream = await fetch(`${base}/v1/emergency/stream/hazards`, {
      headers: { 'last-event-id': 'cursor-42' },
    });
    assert.equal(stream.status, 200);
    assert.equal(seen['last-event-id'], 'cursor-42', 'Last-Event-ID must reach the SSE stream');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
    await new Promise<void>((resolve) => fakeConsole.close(() => resolve()));
  }
});
