// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from './server';

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

test('every /v1/auth request returns 410 workspace_moved', async () => {
  const cases: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'POST', path: '/v1/auth/login', body: { email: 'responder@sos.test', password: 'secret' } },
    { method: 'POST', path: '/v1/auth/register', body: { email: 'new@sos.test', password: 'secret123' } },
    { method: 'POST', path: '/v1/auth/refresh', body: { refresh_token: 'anything' } },
    { method: 'POST', path: '/v1/auth/logout', body: {} },
    { method: 'POST', path: '/v1/auth/change-password', body: { current_password: 'a', new_password: 'b' } },
    { method: 'GET', path: '/v1/auth/me' },
    { method: 'GET', path: '/v1/auth/verify' },
    { method: 'GET', path: '/v1/auth' },
    { method: 'DELETE', path: '/v1/auth/unknown' },
  ];

  for (const probe of cases) {
    const response = await request(probe.path, {
      method: probe.method,
      headers: { 'content-type': 'application/json' },
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    });
    assert.equal(response.status, 410, `${probe.method} ${probe.path}`);
    assert.equal(response.body.error, 'workspace_moved');
    assert.equal(response.body.product, 'sos');
    assert.equal(response.body.workspace_url, 'https://synapsedx.sbs/workspace');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body.access_token, undefined, 'no session may be minted');
    assert.equal(response.body.refresh_token, undefined, 'no session may be minted');
    assert.equal(response.body.user, undefined);
  }
});

test('the public SOS surface and instance metadata stay available', async () => {
  const metadata = await request('/v1/sos');
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.product, 'synapsecity-sos');
});

test('internal emergency routes never treat an anonymous caller as authorized', async () => {
  const response = await request('/v1/emergency/events');
  assert.equal(response.status, 401);
});
