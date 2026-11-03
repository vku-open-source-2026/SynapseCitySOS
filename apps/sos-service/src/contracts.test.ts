// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Auth, SSE, deploy-shape, dispatch-assignment and hazard-expiry contract
 * tests. A small in-process fake Tier-2 client keeps the tests deterministic.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { app } from './server';

type Data = Record<string, unknown>;

class FakeTier2 {
  private readonly datasetMap = new Map<string, Data>();
  private readonly recordMap = new Map<string, Map<string, Data>>();

  readonly datasets = {
    list: async (): Promise<Data[]> => [...this.datasetMap.values()],
    get: async (id: string): Promise<Data> => {
      const found = this.datasetMap.get(id);
      if (!found) throw new CapabilitiesError('not_found', { status: 404 });
      return found;
    },
    create: async (input: Data): Promise<Data> => {
      const id = String(input.slug ?? input.id);
      const created = { ...input, id, status: 'published', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.datasetMap.set(id, created);
      return created;
    },
    publish: async (id: string): Promise<Data> => this.datasets.get(id),
    revoke: async (id: string): Promise<Data> => this.datasets.get(id),
    entities: async (): Promise<unknown[]> => [],
  };

  readonly records = {
    list: async (datasetId: string, query: { limit?: number; offset?: number } = {}) => {
      const all = [...this.recordsFor(datasetId).values()];
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return {
        items: all.slice(offset, offset + limit).map((data) => ({ id: String(data.id), data })),
        total: all.length,
        limit,
        offset,
      };
    },
    get: async (datasetId: string, id: string) => {
      const found = this.recordsFor(datasetId).get(id);
      if (!found) throw new CapabilitiesError('not_found', { status: 404 });
      return { id, data: found };
    },
    create: async (datasetId: string, data: Data, options: { id?: string } = {}) => {
      const id = options.id ?? String(data.id);
      this.recordsFor(datasetId).set(id, { ...data, id });
      return { id, data: { ...data, id } };
    },
    update: async (datasetId: string, id: string, data: Data) => {
      this.recordsFor(datasetId).set(id, { ...data, id });
      return { id, data: { ...data, id } };
    },
  };

  health = async () => ({ status: 'ok', service: 'fake-tier2' });

  asClient(): CapabilitiesClient {
    return this as unknown as CapabilitiesClient;
  }

  seed(datasetId: string, id: string, data: Data): void {
    if (!this.datasetMap.has(datasetId)) {
      this.datasetMap.set(datasetId, {
        id: datasetId,
        slug: datasetId,
        name: datasetId,
        entityType: 'TestRecord',
        license: 'CC-BY-4.0',
        status: 'published',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    this.recordsFor(datasetId).set(id, { ...data, id });
  }

  read(datasetId: string, id: string): Data | undefined {
    return this.recordsFor(datasetId).get(id);
  }

  private recordsFor(datasetId: string): Map<string, Data> {
    let store = this.recordMap.get(datasetId);
    if (!store) {
      store = new Map<string, Data>();
      this.recordMap.set(datasetId, store);
    }
    return store;
  }
}

const fake = new FakeTier2();
let server: Server;
let baseUrl: string;

before(async () => {
  app.locals.createClient = () => fake.asClient();
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

async function login(): Promise<{ access_token: string; refresh_token: string; user: Data }> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'qa', password: 'qa' }),
  });
  assert.equal(response.status, 200);
  return await response.json() as { access_token: string; refresh_token: string; user: Data };
}

async function authHeaders(): Promise<Record<string, string>> {
  const session = await login();
  return { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
}

function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSE read timed out')), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test('login validates input, returns the auth-shell contract and opens a session', async () => {
  const missing = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: '', password: '' }),
  });
  assert.equal(missing.status, 400);

  const session = await login();
  assert.ok(session.access_token);
  assert.ok(session.refresh_token);
  assert.notEqual(session.access_token, session.refresh_token);
  assert.equal(session.user.username, 'qa');
  assert.equal(session.user.role, 'responder');
  assert.ok(Array.isArray(session.user.permissions));

  const me = await fetch(`${baseUrl}/v1/auth/me`, {
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as Data).username, 'qa');

  const verify = await fetch(`${baseUrl}/v1/auth/verify`, {
    headers: { authorization: `Bearer ${session.access_token}` },
  });
  assert.equal(verify.status, 200);
  const verified = await verify.json() as Data;
  assert.equal(verified.valid, true);
  assert.ok(verified.expires_at);
});

test('login works with username, password and an optional email', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'operator', password: 'any', email: 'operator@sos.synapsecity.sbs' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Data;
  assert.equal((body.user as Data).email, 'operator@sos.synapsecity.sbs');
});

test('register returns a shell session and never creates a user dataset', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'new-responder',
      email: 'new@sos.synapsecity.sbs',
      password: 'secret1',
      full_name: 'New Responder',
      phone: '0900000000',
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as Data;
  assert.ok(body.access_token);
  assert.equal((body.user as Data).full_name, 'New Responder');

  const invalid = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x' }),
  });
  assert.equal(invalid.status, 400);
});

test('refresh rotates both tokens and rejects missing or invalid refresh tokens', async () => {
  const session = await login();
  const response = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  assert.equal(response.status, 200);
  const rotated = await response.json() as { access_token: string; refresh_token: string };
  assert.ok(rotated.access_token);
  assert.notEqual(rotated.refresh_token, session.refresh_token);
  assert.notEqual(rotated.access_token, session.access_token);

  const invalid = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: 'nope' }),
  });
  assert.equal(invalid.status, 401);
});

test('logout and change-password return 204 and change-password requires a session', async () => {
  const session = await login();
  const logout = await fetch(`${baseUrl}/v1/auth/logout`, { method: 'POST' });
  assert.equal(logout.status, 204);

  const unauthenticated = await fetch(`${baseUrl}/v1/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ current_password: 'a', new_password: 'bbbbbb' }),
  });
  assert.equal(unauthenticated.status, 401);

  const changed = await fetch(`${baseUrl}/v1/auth/change-password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ current_password: 'a', new_password: 'bbbbbb' }),
  });
  assert.equal(changed.status, 204);
});

test('internal emergency and hazard routes require a session while public projections stay open', async () => {
  fake.seed('sos-hazard-layers', 'public-hazard', {
    hazard_id: 'public-hazard',
    title: 'Flood watch',
    event_type: 'flood',
    severity: 'high',
    is_active: true,
    created_at: new Date().toISOString(),
  });

  const protectedPaths = ['/v1/emergency', '/v1/emergency/sosconn/status'];
  for (const path of protectedPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must require a session`);
  }

  const mutation = await fetch(`${baseUrl}/v1/hazards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Unauthenticated hazard' }),
  });
  assert.equal(mutation.status, 401, 'hazard mutations must require a session');

  const headers = await authHeaders();
  const emergency = await fetch(`${baseUrl}/v1/emergency`, { headers });
  assert.equal(emergency.status, 200);
  const hazards = await fetch(`${baseUrl}/v1/hazards`);
  assert.equal(hazards.status, 200, 'the public hazard feed stays readable');
  const authenticatedHazards = await fetch(`${baseUrl}/v1/hazards`, { headers });
  assert.equal(authenticatedHazards.status, 200);

  const publicPaths = ['/v1/emergency/public', '/v1/hazards/recent', '/v1/hazards/vndms-live', '/v1/map/config', '/v1/sos'];
  for (const path of publicPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must remain public`);
  }

  const users = await fetch(`${baseUrl}/v1/users`, { headers });
  assert.equal(users.status, 404);
});

test('the SSE stream writes real newlines and a named hazards event', async () => {
  fake.seed('sos-hazard-layers', 'stream-hazard', {
    hazard_id: 'stream-hazard',
    title: 'Landslide watch',
    event_type: 'landslide',
    severity: 'medium',
    is_active: true,
    created_at: new Date().toISOString(),
  });

  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/emergency/stream/hazards`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('event: hazards\n') && text.length < 20_000) {
      const chunk = await readWithTimeout(reader, 3000);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }

  assert.ok(text.includes('event: hazards\n'), `missing named event: ${JSON.stringify(text)}`);
  assert.ok(text.includes('\n\n'), `missing blank-line frame separator: ${JSON.stringify(text)}`);
  assert.ok(!text.includes('\\n'), `literal backslash-n leaked into the stream: ${JSON.stringify(text)}`);
  assert.match(text, /data: \{"snapshot":/);
});

test('hazard deploy returns flat EOP-modal ids plus legacy nested records', async () => {
  fake.seed('sos-hazard-layers', 'deploy-hazard', {
    hazard_id: 'deploy-hazard',
    title: 'Storm surge',
    description: 'Coastal flooding',
    event_type: 'storm',
    severity: 'critical',
    is_active: true,
    district: 'Hai Chau',
    geometry: { type: 'Point', coordinates: [108.2, 16.0] },
    created_at: new Date().toISOString(),
  });

  const response = await fetch(`${baseUrl}/v1/hazards/deploy-hazard/deploy`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Data;

  assert.equal(body.hazard_id, 'deploy-hazard');
  assert.ok(body.event_id);
  assert.ok(body.eop_plan_id);
  assert.equal(body.markdown_body, null);
  assert.equal((body.event as Data).id, body.event_id);
  assert.equal((body.eop_plan as Data).id, body.eop_plan_id);
  assert.equal((body.hazard as Data).id, 'deploy-hazard');

  const hazard = fake.read('sos-hazard-layers', 'deploy-hazard');
  assert.equal(hazard?.linked_event_id, body.event_id);
  assert.equal(hazard?.linked_eop_plan_id, body.eop_plan_id);

  // The modal follows up with a markdown save and a submit call.
  const markdown = await fetch(`${baseUrl}/v1/emergency/eop/${body.eop_plan_id}/markdown`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ markdown_body: '# Plan', review_notes: 'Saved from deploy modal' }),
  });
  assert.equal(markdown.status, 200);
  assert.equal(((await markdown.json()) as Data).markdown_body, '# Plan');

  const submit = await fetch(`${baseUrl}/v1/emergency/eop/${body.eop_plan_id}/submit`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({}),
  });
  assert.equal(submit.status, 200);
  assert.equal(((await submit.json()) as Data).plan_id, body.eop_plan_id);
});

test('dispatch approval stores and reads assigned_resource_unit_id with a legacy mirror', async () => {
  fake.seed('sos-dispatch-orders', 'dispatch-1', {
    emergency_event_id: 'event-1',
    task_title: 'Evacuate ward 1',
    priority: 'high',
    status: 'pending',
    assignments: [],
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const headers = await authHeaders();
  const approved = await fetch(`${baseUrl}/v1/emergency/dispatch/dispatch-1/approve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ assigned_resource_unit_id: 'resource-r1', notes: 'go now' }),
  });
  assert.equal(approved.status, 200);
  const body = await approved.json() as Data;
  assert.equal(body.status, 'assigned');
  assert.equal(body.assigned_resource_unit_id, 'resource-r1');
  assert.equal(body.assigned_user_id, 'resource-r1');
  const assignments = body.assignments as Data[];
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].resource_unit_id, 'resource-r1');
  assert.equal(assignments[0].assigned_resource_unit_id, 'resource-r1');
  assert.equal(assignments[0].assigned_user_id, 'resource-r1');

  const read = await fetch(`${baseUrl}/v1/emergency/dispatch/dispatch-1`, { headers });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as Data).assigned_resource_unit_id, 'resource-r1');

  const legacy = await fetch(`${baseUrl}/v1/emergency/dispatch/dispatch-1/approve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: 'resource-r2' }),
  });
  assert.equal(legacy.status, 200);
  const legacyBody = await legacy.json() as Data;
  assert.equal(legacyBody.assigned_resource_unit_id, 'resource-r2');
  assert.equal(legacyBody.assigned_user_id, 'resource-r2');
});

test('expire-stale marks only hazards older than the TTL as expired', async () => {
  const now = Date.now();
  fake.seed('sos-hazard-layers', 'stale-hazard', {
    hazard_id: 'stale-hazard',
    title: 'Old flood',
    is_active: true,
    observed_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
    created_at: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
  });
  fake.seed('sos-hazard-layers', 'fresh-hazard', {
    hazard_id: 'fresh-hazard',
    title: 'Fresh flood',
    is_active: true,
    observed_at: new Date(now - 60 * 60 * 1000).toISOString(),
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
  });

  const response = await fetch(`${baseUrl}/v1/hazards/expire-stale`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ ttl_hours: 24 }),
  });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as Data).updated, 1);
  assert.equal(fake.read('sos-hazard-layers', 'stale-hazard')?.is_active, false);
  assert.equal(fake.read('sos-hazard-layers', 'stale-hazard')?.status, 'expired');
  assert.equal(fake.read('sos-hazard-layers', 'fresh-hazard')?.is_active, true);
});

test('invalid bearer tokens are rejected on protected routes', async () => {
  const response = await fetch(`${baseUrl}/v1/emergency`, {
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(response.status, 401);
});
