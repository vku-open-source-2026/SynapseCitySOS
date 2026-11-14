// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Auth, boundary, hazard, geo, VNDMS, EOP, dispatch, SITREP, AAR, SSE and
 * dependency-failure contract tests. A small in-process fake Tier-2 client
 * keeps the tests deterministic.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { app } from './server';
import { resetAiStatusCache } from './ai';
import { issueSessionForRole, type AuthUserRole } from './auth';

type Data = Record<string, unknown>;

function ngsi(id: string, data: Data): Data {
  const entity: Data = { id, type: 'Thing' };
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || key === 'created_at' || key === 'updated_at') continue;
    entity[key] = key === 'geometry'
      ? { type: 'GeoProperty', value }
      : { type: 'Property', value };
  }
  return entity;
}

class FakeTier2 {
  private readonly datasetMap = new Map<string, Data>();
  private readonly recordMap = new Map<string, Map<string, Data>>();
  private readonly versionMap = new Map<string, number>();
  private readonly eventLog: Array<{ id: string; event: Data }> = [];
  private readonly jobMap = new Map<string, Data>();
  private readonly jobRunMap = new Map<string, Data[]>();
  healthFail = false;
  entitiesFail = false;
  aiFail = false;
  aiConfigured = true;
  jobsFail = false;
  aiDraft: unknown = {
    summary: 'Kế hoạch ứng phó lũ cho khu vực bị ảnh hưởng.',
    objectives: ['Bảo vệ tính mạng người dân', 'Duy trì chỉ huy thống nhất', 'Khôi phục dịch vụ thiết yếu'],
    operational_phases: ['prepare', 'respond', 'recover'],
    actions: [
      { action_id: 'evacuate-ai', title: 'Sơ tán dân cư vùng trũng', description: 'Sơ tán theo tuyến đã xác định.', phase: 'respond', priority: 'critical', owner_role: 'operations_lead', estimated_minutes: 90, dependencies: [], required_capability: 'personnel' },
      { action_id: 'pump-ai', title: 'Bơm tiêu nước', description: 'Triển khai máy bơm tại điểm ngập sâu.', phase: 'respond', priority: 'high', owner_role: 'operations_lead', estimated_minutes: 60, dependencies: ['evacuate-ai'], required_capability: 'rescue_equipment' },
      { action_id: 'recover-ai', title: 'Khôi phục dịch vụ', description: 'Đánh giá thiệt hại và khôi phục dịch vụ.', phase: 'recover', priority: 'medium', owner_role: 'recovery_lead', estimated_minutes: 240, dependencies: [], required_capability: 'personnel' },
    ],
    evacuation_plan: ['Sơ tán hộ dân tại khu vực ngập sâu.'],
    fallback_plan: ['Chuyển kênh vô tuyến dự phòng.'],
    communications_plan: ['Cập nhật bản đồ công khai mỗi 30 phút.'],
  };
  lastEventsQuery: Data | null = null;
  readonly eventsQueries: Data[] = [];
  aiCalls = 0;

  readonly datasets = {
    list: async (): Promise<Data[]> => [...this.datasetMap.values()],
    get: async (id: string): Promise<Data> => {
      const found = this.datasetMap.get(id);
      if (!found) throw new CapabilitiesError('not_found', { status: 404 });
      return found;
    },
    create: async (input: Data): Promise<Data> => {
      const id = String(input.slug ?? input.id);
      const created = { ...input, id, status: input.public === true ? 'published' : 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.datasetMap.set(id, created);
      return created;
    },
    publish: async (id: string): Promise<Data> => {
      const found = await this.datasets.get(id);
      const published = { ...found, status: 'published' };
      this.datasetMap.set(id, published);
      return published;
    },
    revoke: async (id: string): Promise<Data> => {
      const found = await this.datasets.get(id);
      const revoked = { ...found, status: 'revoked' };
      this.datasetMap.set(id, revoked);
      return revoked;
    },
    entities: async (id: string, query: { limit?: number; offset?: number } = {}): Promise<unknown[]> => {
      if (this.entitiesFail) throw new CapabilitiesError('tier2_unavailable', { status: 503 });
      // The publication API only returns records of a published, public dataset.
      const found = this.datasetMap.get(id);
      if (!found || found.status !== 'published' || found.public !== true) return [];
      const all = [...this.recordsFor(id).values()].filter((data) => data.published !== false);
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return all.slice(offset, offset + limit).map((data) => ngsi(String(data.id), data));
    },
  };

  readonly events = {
    list: async (query: { since?: string; datasetId?: string; limit?: number } = {}) => {
      this.lastEventsQuery = { ...query };
      this.eventsQueries.push({ ...query });
      const start = query.since ? this.eventLog.findIndex((item) => item.id === query.since) + 1 : 0;
      const items = this.eventLog
        .slice(start < 0 ? 0 : start)
        .filter((item) => !query.datasetId || item.event.datasetId === query.datasetId)
        .slice(0, query.limit ?? 100);
      return { items, count: items.length, nextCursor: items.length ? items[items.length - 1].id : query.since ?? null };
    },
  };

  readonly jobs = {
    list: async (): Promise<{ items: Data[] }> => {
      if (this.jobsFail) throw new CapabilitiesError('capability_unavailable', { status: 503 });
      return { items: [...this.jobMap.values()] };
    },
    get: async (id: string): Promise<Data> => {
      if (this.jobsFail) throw new CapabilitiesError('capability_unavailable', { status: 503 });
      const job = this.jobMap.get(id);
      if (!job) throw new CapabilitiesError('job_not_found', { status: 404 });
      return job;
    },
    runs: async (id: string): Promise<{ items: Data[] }> => {
      if (this.jobsFail) throw new CapabilitiesError('capability_unavailable', { status: 503 });
      return { items: [...(this.jobRunMap.get(id) ?? [])] };
    },
  };

  readonly ai = {
    status: async (): Promise<Data> => {
      if (this.aiFail) throw new CapabilitiesError('capability_unavailable', { status: 503 });
      if (!this.aiConfigured) {
        return { capability: 'ai', status: 'unconfigured', dependency: 'synapseone-inference', upstream: { status: 'unconfigured' }, model: null };
      }
      return { capability: 'ai', status: 'ok', dependency: 'synapseone-inference', upstream: { status: 'ok' }, model: 'fake-eop-model' };
    },
    chat: async (messages: Data[]): Promise<Data> => {
      this.aiCalls += 1;
      if (this.aiFail) throw new CapabilitiesError('ai_unavailable', { status: 503, code: 'ai_unavailable' });
      const content = typeof this.aiDraft === 'string' ? this.aiDraft : JSON.stringify(this.aiDraft);
      return {
        id: 'chat-fake-1',
        object: 'chat.completion',
        created: Date.now(),
        model: 'fake-eop-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        prompt_messages: messages.length,
      };
    },
  };

  readonly records = {
    list: async (datasetId: string, query: { limit?: number; offset?: number } = {}) => {
      const all = [...this.recordsFor(datasetId).values()];
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 100;
      return {
        items: all.slice(offset, offset + limit).map((data) => ({ id: String(data.id), data, version: this.versionMap.get(`${datasetId}:${data.id}`) ?? 1 })),
        total: all.length,
        limit,
        offset,
      };
    },
    get: async (datasetId: string, id: string) => {
      const found = this.recordsFor(datasetId).get(id);
      if (!found) throw new CapabilitiesError('not_found', { status: 404 });
      return { id, data: found, version: this.versionMap.get(`${datasetId}:${id}`) ?? 1 };
    },
    create: async (datasetId: string, data: Data, options: { id?: string } = {}) => {
      const id = options.id ?? String(data.id);
      const key = `${datasetId}:${id}`;
      if (this.recordsFor(datasetId).has(id)) throw new CapabilitiesError('record_exists', { status: 409 });
      this.recordsFor(datasetId).set(id, { ...data, id });
      const version = (this.versionMap.get(key) ?? 0) + 1;
      this.versionMap.set(key, version);
      this.emit(`record.created:${datasetId}:${id}`, datasetId, id, 'record.created');
      return { id, data: { ...data, id }, version };
    },
    update: async (datasetId: string, id: string, data: Data, options: { ifVersion?: number } = {}) => {
      const key = `${datasetId}:${id}`;
      const current = this.versionMap.get(key) ?? 1;
      if (options.ifVersion !== undefined && options.ifVersion !== current) {
        throw new CapabilitiesError('version_conflict', { status: 409 });
      }
      this.recordsFor(datasetId).set(id, { ...data, id });
      const version = current + 1;
      this.versionMap.set(key, version);
      this.emit(`record.updated:${datasetId}:${id}:${version}`, datasetId, id, 'record.updated');
      return { id, data: { ...data, id }, version };
    },
  };

  health = async () => {
    if (this.healthFail) throw new CapabilitiesError('tier2_unavailable', { status: 503 });
    return { status: 'ok', service: 'fake-tier2' };
  };

  asClient(): CapabilitiesClient {
    return this as unknown as CapabilitiesClient;
  }

  private emit(id: string, datasetId: string, recordId: string, type: string): void {
    this.eventLog.push({
      id,
      event: { eventId: id, type, schemaVersion: 1, datasetId, recordId, at: new Date().toISOString(), correlationId: 'fake' },
    });
  }

  seedJob(id: string, job: Data, runs: Data[] = []): void {
    this.jobMap.set(id, { id, enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...job });
    this.jobRunMap.set(id, runs);
  }

  clearJobs(): void {
    this.jobMap.clear();
    this.jobRunMap.clear();
  }

  setDatasetStatus(datasetId: string, status: string): void {
    const found = this.datasetMap.get(datasetId);
    if (!found) throw new Error(`dataset ${datasetId} is not seeded`);
    this.datasetMap.set(datasetId, { ...found, status });
  }

  /** Insert a record without emitting an event (fixture setup). */
  seed(datasetId: string, id: string, data: Data): void {
    if (!this.datasetMap.has(datasetId)) {
      this.datasetMap.set(datasetId, {
        id: datasetId,
        slug: datasetId,
        name: datasetId,
        entityType: 'TestRecord',
        license: 'CC-BY-4.0',
        status: 'published',
        public: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    this.recordsFor(datasetId).set(id, { ...data, id });
    this.versionMap.set(`${datasetId}:${id}`, 1);
  }

  read(datasetId: string, id: string): Data | undefined {
    return this.recordsFor(datasetId).get(id);
  }

  entries(datasetId: string): Data[] {
    return [...this.recordsFor(datasetId).values()];
  }

  recordVersion(datasetId: string, id: string): number {
    return this.versionMap.get(`${datasetId}:${id}`) ?? 1;
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
  // This file exercises the explicit development-only demo shell; Tier-2
  // identity has its own suite in identity.test.ts.
  process.env.SOS_AUTH_MODE = 'demo';
  // Non-production test only: keep the pre-migration auth routes reachable.
  process.env.TIER3_AUTH_MODE = 'legacy';
  process.env.ALLOW_DEMO_AUTH = 'true';
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

function tokenFor(role: AuthUserRole, username = `qa-${role}`): string {
  return issueSessionForRole(role, username).access_token;
}

function headersFor(role: AuthUserRole): Record<string, string> {
  return { authorization: `Bearer ${tokenFor(role)}`, 'content-type': 'application/json' };
}

async function login(): Promise<{ access_token: string; refresh_token: string; user: Data }> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'qa', password: 'qa' }),
  });
  assert.equal(response.status, 200);
  return await response.json() as { access_token: string; refresh_token: string; user: Data };
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

// ── Auth ────────────────────────────────────────────────────────────────────

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

  const me = await fetch(`${baseUrl}/v1/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as Data).username, 'qa');
});

test('client-supplied roles are ignored; demo never grants admin', async () => {
  const registered = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'attacker', email: 'a@b.co', password: 'x', full_name: 'Attacker', role: 'admin',
    }),
  });
  assert.equal(registered.status, 201);
  const body = await registered.json() as Data;
  assert.equal((body.user as Data).role, 'volunteer');
  assert.ok(!((body.user as Data).permissions as string[]).includes('emergency:admin'));
  assert.ok(!((body.user as Data).permissions as string[]).includes('emergency:write'));

  const loginResponse = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'anyone', password: 'anything', role: 'admin' }),
  });
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json() as Data;
  assert.equal((loginBody.user as Data).role, 'responder');
  assert.ok(!((loginBody.user as Data).permissions as string[]).includes('emergency:admin'));
});

test('demo auth fails closed when ALLOW_DEMO_AUTH is not enabled', async () => {
  const previous = process.env.ALLOW_DEMO_AUTH;
  process.env.ALLOW_DEMO_AUTH = 'false';
  try {
    const response = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y' }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as Data).error, 'demo_auth_disabled');
  } finally {
    process.env.ALLOW_DEMO_AUTH = previous;
  }
});

test('register returns a read-only shell session and no user dataset', async () => {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'new-responder', email: 'new@sos.synapsecity.sbs', password: 'secret1', full_name: 'New Responder',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(((await response.json()) as Data).user instanceof Object, true);

  const invalid = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'x' }),
  });
  assert.equal(invalid.status, 400);
});

test('refresh rotates both tokens and rejects invalid refresh tokens', async () => {
  const session = await login();
  const response = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  assert.equal(response.status, 200);
  const rotated = await response.json() as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, session.refresh_token);
  assert.notEqual(rotated.access_token, session.access_token);

  const invalid = await fetch(`${baseUrl}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: 'nope' }),
  });
  assert.equal(invalid.status, 401);
});

test('tokens in a query string are rejected', async () => {
  const token = tokenFor('manager');
  const response = await fetch(`${baseUrl}/v1/emergency?access_token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 401);
});

test('role escalation is denied on every mutation family', async () => {
  fake.seed('sos-resource-units', 'role-resource', { name: 'Team', resource_type: 'personnel', status: 'available' });
  fake.seed('sos-dispatch-orders', 'role-dispatch', { emergency_event_id: 'e-role', task_title: 'Task', status: 'pending', assignments: [] });
  const citizen = headersFor('citizen');
  const volunteer = headersFor('volunteer');
  const responder = headersFor('responder');
  const manager = headersFor('manager');

  // Read-only roles cannot mutate.
  for (const headers of [citizen, volunteer]) {
    const dispatch = await fetch(`${baseUrl}/v1/emergency/dispatch`, {
      method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'e-1', task_title: 'x' }),
    });
    assert.equal(dispatch.status, 403, 'read-only role must not create dispatch orders');
    const hazard = await fetch(`${baseUrl}/v1/hazards`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'x', event_type: 'flood' }),
    });
    assert.equal(hazard.status, 403, 'read-only role must not create hazards');
  }

  // A responder can write but cannot dispatch or publish EOPs.
  const responderDispatch = await fetch(`${baseUrl}/v1/emergency/dispatch/role-dispatch/approve`, {
    method: 'POST', headers: responder, body: JSON.stringify({ assigned_resource_unit_id: 'role-resource' }),
  });
  assert.equal(responderDispatch.status, 403);
  const responderEopPublish = await fetch(`${baseUrl}/v1/emergency/eop/any/publish`, {
    method: 'POST', headers: responder, body: JSON.stringify({}),
  });
  assert.equal(responderEopPublish.status, 403);

  // A manager can dispatch.
  const managerApprove = await fetch(`${baseUrl}/v1/emergency/dispatch/role-dispatch/approve`, {
    method: 'POST', headers: manager, body: JSON.stringify({ assigned_resource_unit_id: 'role-resource' }),
  });
  assert.equal(managerApprove.status, 200);

  // Anonymous mutation is 401.
  const anonymous = await fetch(`${baseUrl}/v1/emergency/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(anonymous.status, 401);
});

// ── Health / boundary ───────────────────────────────────────────────────────

test('GET /v1/sos advertises emergency-only ownership', async () => {
  const response = await fetch(`${baseUrl}/v1/sos`);
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as Data;
  assert.equal(metadata.product, 'synapsecity-sos');
  assert.equal(metadata.publicUrl, 'https://sos.synapsecity.sbs');
  for (const feature of ['hazards', 'emergency events', 'EOP', 'dispatch', 'resource units', 'SITREP', 'AAR', 'live hazard stream', 'public hazard map']) {
    assert.ok((metadata.features as string[]).includes(feature), `missing feature: ${feature}`);
  }
  for (const dataset of metadata.datasets as string[]) assert.match(dataset, /^sos-/);
});

test('health reports per-dependency state and /ready fails when Tier-2 is down', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const body = await health.json() as Data;
  const dependencies = body.dependencies as Data[];
  assert.equal(dependencies.length, 1);
  assert.equal(dependencies[0].name, 'synapsedx');
  assert.equal(dependencies[0].reachable, true);
  assert.ok(dependencies[0].checked_at);

  fake.healthFail = true;
  try {
    const degraded = await fetch(`${baseUrl}/health`);
    assert.equal(degraded.status, 200);
    const degradedBody = await degraded.json() as Data;
    assert.equal(degradedBody.status, 'degraded');
    assert.equal((degradedBody.dependencies as Data[])[0].reachable, false);

    const ready = await fetch(`${baseUrl}/ready`);
    assert.equal(ready.status, 503);
  } finally {
    fake.healthFail = false;
  }

  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /sos_request_total/);
});

test('foreign, encoded and unknown namespaces still return 404 JSON', async () => {
  for (const path of ['/v1/assets', '/v1/incidents/1', '/v1/users', '/v1/public/assets', '/v1/%61ssets', '/v1/unknown']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.deepEqual(await response.json(), { error: 'not_found', product: 'synapsecity-sos' });
  }
});

// ── Hazard filters ──────────────────────────────────────────────────────────

test('active_only filters is_active explicitly (issue #11)', async () => {
  const headers = headersFor('manager');
  const active = await fetch(`${baseUrl}/v1/hazards`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: 'h-filter-active', hazard_id: 'H-FA', title: 'Active flood', event_type: 'flood', severity: 'high', source: 'vndms', is_active: true, geometry: { type: 'Point', coordinates: [108, 16] } }),
  });
  assert.equal(active.status, 201);
  const inactive = await fetch(`${baseUrl}/v1/hazards`, {
    method: 'POST', headers,
    body: JSON.stringify({ id: 'h-filter-inactive', hazard_id: 'H-FI', title: 'Inactive flood', event_type: 'flood', severity: 'low', source: 'vndms', is_active: false, geometry: { type: 'Point', coordinates: [108, 16] } }),
  });
  assert.equal(inactive.status, 201);

  const activeOnly = await fetch(`${baseUrl}/v1/hazards?active_only=true`);
  assert.equal(activeOnly.status, 200);
  const activeRows = await activeOnly.json() as Data[];
  assert.ok(activeRows.some((row) => row.id === 'h-filter-active'));
  assert.ok(!activeRows.some((row) => row.id === 'h-filter-inactive'));

  const inactiveOnly = await fetch(`${baseUrl}/v1/hazards?active_only=false`);
  const inactiveRows = await inactiveOnly.json() as Data[];
  assert.ok(inactiveRows.some((row) => row.id === 'h-filter-inactive'));
  assert.ok(!inactiveRows.some((row) => row.id === 'h-filter-active'));

  const all = await (await fetch(`${baseUrl}/v1/hazards`)).json() as Data[];
  assert.ok(all.some((row) => row.id === 'h-filter-active'));
  assert.ok(all.some((row) => row.id === 'h-filter-inactive'));

  const byBoolean = await (await fetch(`${baseUrl}/v1/hazards?is_active=false`)).json() as Data[];
  assert.ok(byBoolean.some((row) => row.id === 'h-filter-inactive'));
  assert.ok(!byBoolean.some((row) => row.id === 'h-filter-active'));
});

test('recent hazards honour hours and exclude expired records', async () => {
  const now = Date.now();
  fake.seed('sos-hazard-layers', 'recent-old', { hazard_id: 'recent-old', title: 'Old', is_active: true, observed_at: new Date(now - 48 * 3600_000).toISOString(), geometry: { type: 'Point', coordinates: [108, 16] } });
  fake.seed('sos-hazard-layers', 'recent-new', { hazard_id: 'recent-new', title: 'New', is_active: true, observed_at: new Date(now - 3600_000).toISOString(), geometry: { type: 'Point', coordinates: [108, 16] } });
  fake.seed('sos-hazard-layers', 'recent-expired', { hazard_id: 'recent-expired', title: 'Expired', is_active: false, status: 'expired', observed_at: new Date(now - 3600_000).toISOString(), geometry: { type: 'Point', coordinates: [108, 16] } });
  const rows = await (await fetch(`${baseUrl}/v1/hazards/recent?hours=24`)).json() as Data[];
  assert.ok(rows.some((row) => row.id === 'recent-new'));
  assert.ok(!rows.some((row) => row.id === 'recent-old'));
  assert.ok(!rows.some((row) => row.id === 'recent-expired'));
});

// ── Geo ─────────────────────────────────────────────────────────────────────

test('near and in-polygon use real geometry (issue #12)', async () => {
  fake.seed('sos-hazard-layers', 'geo-near', { hazard_id: 'geo-near', title: 'Near', event_type: 'flood', severity: 'high', is_active: true, geometry: { type: 'Point', coordinates: [104, 10] } });
  fake.seed('sos-hazard-layers', 'geo-far', { hazard_id: 'geo-far', title: 'Far', event_type: 'flood', severity: 'high', is_active: true, geometry: { type: 'Point', coordinates: [109, 17] } });

  const far = await (await fetch(`${baseUrl}/v1/hazards/geo/near?lat=10&lng=100&radius_m=1000`)).json() as Data;
  assert.equal((far.items as Data[]).length, 0);

  const near = await (await fetch(`${baseUrl}/v1/hazards/geo/near?lat=10&lng=104&radius_m=5000`)).json() as Data;
  assert.deepEqual((near.items as Data[]).map((row) => row.id), ['geo-near']);
  assert.ok(typeof (near.items as Data[])[0].distance_m === 'number');

  const outside = await (await fetch(`${baseUrl}/v1/hazards/geo/near?lat=10&lng=100&radius_m=999999`)).json() as Data;
  assert.equal(outside.error, 'invalid_radius');

  const bad = await (await fetch(`${baseUrl}/v1/hazards/geo/near?lat=999&lng=108`)).json() as Data;
  assert.equal(bad.error, 'invalid_coordinates');

  const polygon = {
    type: 'Polygon',
    coordinates: [[[103.5, 9.5], [104.5, 9.5], [104.5, 10.5], [103.5, 10.5], [103.5, 9.5]]],
  };
  const inside = await (await fetch(`${baseUrl}/v1/hazards/geo/in-polygon`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ polygon }),
  })).json() as Data;
  assert.deepEqual((inside.items as Data[]).map((row) => row.id), ['geo-near']);

  const empty = await fetch(`${baseUrl}/v1/hazards/geo/in-polygon`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ polygon: [] }),
  });
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as Data).error, 'invalid_geometry');
});

// ── VNDMS ───────────────────────────────────────────────────────────────────

test('VNDMS live returns the flat wire schema and ingest status is honest', async () => {
  fake.seed('sos-hazard-layers', 'vndms-live-1', {
    hazard_id: 'VNDMS-1', title: 'Flood A', description: 'Rising water', event_type: 'flood', severity: 'high',
    source: 'vndms', is_active: true, district: 'Hai Chau', observed_at: new Date().toISOString(),
    geometry: { type: 'Point', coordinates: [108, 16] },
  });
  const live = await (await fetch(`${baseUrl}/v1/hazards/vndms-live`)).json() as Data[];
  const row = live.find((item) => item.hazard_id === 'VNDMS-1');
  assert.ok(row);
  assert.equal(row?.lat, 16);
  assert.equal(row?.lon, 108);
  assert.equal(row?.warning_type, 'warning_flood');
  assert.equal(row?.warning_level, 3);
  assert.equal(row?.severity, 'high');

  const status = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
  assert.equal(status.status, 'unconfigured');
  assert.equal(status.last_run_at, null);

  const ingest = await fetch(`${baseUrl}/v1/hazards/ingest`, {
    method: 'POST',
    headers: headersFor('manager'),
    body: JSON.stringify({ feed_version: 'v1', records: [
      { hazard_id: 'VNDMS-2', title: 'Storm B', event_type: 'storm', severity: 'medium', lat: 16.1, lon: 108.1, warning_type: 'warning_wind', warning_level: 2 },
      { title: 'missing id' },
    ] }),
  });
  assert.equal(ingest.status, 201);
  const ingestBody = await ingest.json() as Data;
  assert.equal(ingestBody.ingested, 1);
  assert.equal((ingestBody.rejected as unknown[]).length, 1);

  const after = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
  assert.notEqual(after.status, 'unconfigured');
  assert.equal(after.records_ingested, 1);
  assert.equal(after.records_rejected, 1);
});

// ── EOP ─────────────────────────────────────────────────────────────────────

test('EOP draft is AI-generated, event-specific, versioned and idempotent (issue #14)', async () => {
  fake.seed('sos-emergency-events', 'eop-event', {
    id: 'eop-event', title: 'Flood at Hai Chau', event_type: 'flood', severity: 'high', status: 'active',
    location: { district: 'Hai Chau', ward: 'Thach Thang' }, estimated_impact: { evacuated_people: 120 },
    created_at: new Date().toISOString(), metadata: {},
  });
  fake.seed('sos-resource-units', 'eop-resource', { name: 'Team 1', resource_type: 'personnel', status: 'available', district: 'Hai Chau' });

  const headers = headersFor('manager');
  const callsBefore = fake.aiCalls;
  const first = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-event' }),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json() as Data;
  assert.equal(firstBody.version, 1);
  assert.equal(firstBody.generated_by, 'tier2-ai');
  assert.equal(firstBody.source, 'tier2-ai');
  assert.equal(fake.aiCalls, callsBefore + 1, 'the Tier-2 AI capability must be called');
  assert.ok((firstBody.objectives as unknown[]).length > 0);
  assert.ok((firstBody.actions as unknown[]).length > 0);
  assert.equal((firstBody.assignment_matrix as unknown[]).length, (firstBody.actions as unknown[]).length);
  assert.ok((firstBody.evacuation_plan as unknown[]).length > 0);
  assert.ok(typeof firstBody.markdown_body === 'string' && (firstBody.markdown_body as string).length > 100);
  assert.ok((firstBody.markdown_body as string).includes('AI (fake-eop-model)'));
  const metadata = firstBody.metadata as Data;
  assert.equal(metadata.generated_by, 'tier2-ai');
  assert.equal(metadata.model, 'fake-eop-model');
  assert.equal(metadata.prompt_version, 'sos-eop-prompt-v1');
  assert.equal(metadata.ai_provider, 'synapsedx');
  assert.ok(metadata.generated_at);
  assert.deepEqual((metadata.source_refs as Data).emergency_event_id, 'eop-event');
  assert.ok((metadata.usage as Data).total_tokens);

  const again = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-event' }),
  });
  assert.equal(again.status, 200);
  const againBody = await again.json() as Data;
  assert.equal(againBody.id, firstBody.id);
  assert.equal(againBody.generated, false);
  assert.equal(fake.aiCalls, callsBefore + 1, 'an idempotent request must not call the model again');

  const forced = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-event', force_new_version: true }),
  });
  assert.equal(forced.status, 201);
  const forcedBody = await forced.json() as Data;
  assert.equal(forcedBody.version, 2);
  assert.notEqual(forcedBody.id, firstBody.id);
  const versions = fake.entries('sos-eop-plans')
    .filter((plan) => plan.emergency_event_id === 'eop-event')
    .map((plan) => Number(plan.version))
    .sort();
  assert.deepEqual(versions, [1, 2], 'force_new_version must never create a second v1');

  const forcedAgain = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-event', force_new_version: true }),
  });
  assert.equal(forcedAgain.status, 201);
  assert.equal(((await forcedAgain.json()) as Data).version, 3);
});

test('an unavailable AI returns a typed 503 and never writes an empty template (issue #14)', async () => {
  fake.seed('sos-emergency-events', 'eop-ai-down', {
    id: 'eop-ai-down', title: 'Storm response', event_type: 'storm', severity: 'critical', status: 'active',
    location: { district: 'Son Tra' }, created_at: new Date().toISOString(), metadata: {},
  });
  const headers = headersFor('manager');
  fake.aiFail = true;
  try {
    const response = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
      method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-ai-down' }),
    });
    assert.equal(response.status, 503);
    const body = await response.json() as Data;
    assert.equal(body.error, 'ai_capability_unavailable');
    assert.deepEqual(body.details, {
      dependency: 'synapsedx', capability: 'ai', retryable: true, upstream_status: 503, upstream_code: 'ai_unavailable',
    });
    assert.equal(
      fake.entries('sos-eop-plans').filter((plan) => plan.emergency_event_id === 'eop-ai-down').length,
      0,
      'a 503 must not persist an empty plan',
    );

    const fallback = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ emergency_event_id: 'eop-ai-down', fallback: 'deterministic' }),
    });
    assert.equal(fallback.status, 201);
    const draft = await fallback.json() as Data;
    assert.equal(draft.generated_by, 'deterministic-fallback');
    assert.equal(draft.warning, 'ai_unavailable_deterministic_fallback');
    assert.ok((draft.objectives as unknown[]).length > 0);
    assert.ok((draft.actions as unknown[]).length > 0);
    assert.ok((draft.markdown_body as string).includes('deterministic-fallback'));
    assert.equal((draft.metadata as Data).ai_error_code, 'ai_capability_unavailable');
  } finally {
    fake.aiFail = false;
    resetAiStatusCache();
  }
});

test('no model call is made when Tier-2 reports the AI capability unconfigured (issue #14)', async () => {
  fake.seed('sos-emergency-events', 'eop-ai-unconfigured', {
    id: 'eop-ai-unconfigured', title: 'Drought', event_type: 'drought', severity: 'medium', status: 'active',
    location: { district: 'Cam Le' }, created_at: new Date().toISOString(), metadata: {},
  });
  const calls = fake.aiCalls;
  fake.aiConfigured = false;
  resetAiStatusCache();
  try {
    const response = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
      method: 'POST', headers: headersFor('manager'), body: JSON.stringify({ emergency_event_id: 'eop-ai-unconfigured' }),
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as Data).error, 'ai_capability_unavailable');
    assert.equal(fake.aiCalls, calls, 'an unconfigured capability must not spend a model call');
    assert.equal(fake.entries('sos-eop-plans').filter((plan) => plan.emergency_event_id === 'eop-ai-unconfigured').length, 0);
  } finally {
    fake.aiConfigured = true;
    resetAiStatusCache();
  }
});

test('an invalid AI completion is a typed 502, not a silent template (issue #14)', async () => {
  fake.seed('sos-emergency-events', 'eop-ai-bad', {
    id: 'eop-ai-bad', title: 'Landslide', event_type: 'landslide', severity: 'high', status: 'active',
    location: { district: 'Hoa Vang' }, created_at: new Date().toISOString(), metadata: {},
  });
  const headers = headersFor('manager');
  const valid = fake.aiDraft;
  fake.aiDraft = 'I am afraid I cannot produce JSON today.';
  try {
    const response = await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
      method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'eop-ai-bad' }),
    });
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as Data).error, 'ai_draft_invalid');
    assert.equal(fake.entries('sos-eop-plans').filter((plan) => plan.emergency_event_id === 'eop-ai-bad').length, 0);
  } finally {
    fake.aiDraft = valid;
  }
});

test('EOP submit creates dispatch orders once and optimize assigns units (issue #15)', async () => {
  fake.seed('sos-emergency-events', 'dispatch-event', {
    id: 'dispatch-event', title: 'Storm response', event_type: 'storm', severity: 'critical', status: 'active',
    location: { district: 'Son Tra' }, created_at: new Date().toISOString(), metadata: {},
  });
  fake.seed('sos-resource-units', 'dispatch-resource', { name: 'Rescue 1', resource_type: 'personnel', status: 'available', district: 'Son Tra', current_location: { type: 'Point', coordinates: [108.2, 16.1] } });
  const headers = headersFor('manager');
  const draft = await (await fetch(`${baseUrl}/v1/emergency/eop/generate-draft`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'dispatch-event' }),
  })).json() as Data;
  const planId = String(draft.id);

  const submit = await fetch(`${baseUrl}/v1/emergency/eop/${planId}/submit`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(submit.status, 200);
  const submitted = await submit.json() as Data;
  const firstOrders = submitted.orders as Data[];
  assert.ok(firstOrders.length > 0);
  assert.ok(firstOrders.every((order) => order.status === 'pending' && order.eop_plan_id === planId));

  const resubmit = await (await fetch(`${baseUrl}/v1/emergency/eop/${planId}/submit`, { method: 'POST', headers, body: JSON.stringify({}) })).json() as Data;
  assert.deepEqual((resubmit.orders as Data[]).map((order) => order.id).sort(), firstOrders.map((order) => order.id).sort());
  assert.equal(resubmit.created, 0);

  const optimize = await fetch(`${baseUrl}/v1/emergency/dispatch/optimize`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(optimize.status, 200);
  const optimized = await optimize.json() as Data;
  assert.ok(Number(optimized.auto_assigned) >= 1);
  assert.ok(Number(optimized.eta_reestimated) >= 1);
  const assigned = fake.entries('sos-dispatch-orders').filter((order) => order.status === 'assigned');
  assert.ok(assigned.some((order) => order.assigned_resource_unit_id === 'dispatch-resource' && typeof order.eta_minutes === 'number'));
});

test('approval requires an existing usable resource unit (issue #20)', async () => {
  fake.seed('sos-dispatch-orders', 'approve-order', { emergency_event_id: 'e-x', task_title: 'Task', status: 'pending', assignments: [] });
  fake.seed('sos-resource-units', 'approve-offline', { name: 'Offline', resource_type: 'personnel', status: 'offline' });
  const headers = headersFor('manager');

  const missing = await fetch(`${baseUrl}/v1/emergency/dispatch/approve-order/approve`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(missing.status, 400);
  assert.equal(((await missing.json()) as Data).error, 'assigned_resource_unit_id_required');
  assert.equal(fake.read('sos-dispatch-orders', 'approve-order')?.status, 'pending');

  const unknown = await fetch(`${baseUrl}/v1/emergency/dispatch/approve-order/approve`, { method: 'POST', headers, body: JSON.stringify({ assigned_resource_unit_id: 'nope' }) });
  assert.equal(unknown.status, 404);

  const offline = await fetch(`${baseUrl}/v1/emergency/dispatch/approve-order/approve`, { method: 'POST', headers, body: JSON.stringify({ assigned_resource_unit_id: 'approve-offline' }) });
  assert.equal(offline.status, 409);

  const ok = await fetch(`${baseUrl}/v1/emergency/dispatch/approve-order/approve`, { method: 'POST', headers, body: JSON.stringify({ assigned_resource_unit_id: 'dispatch-resource' }) });
  assert.equal(ok.status, 200);
  const body = await ok.json() as Data;
  assert.equal(body.status, 'assigned');
  assert.equal(body.assigned_resource_unit_id, 'dispatch-resource');
  assert.equal(body.assigned_user_id, 'dispatch-resource');
});

// ── Deploy idempotency ──────────────────────────────────────────────────────

test('hazard deploy is idempotent per hazard (issue #20)', async () => {
  fake.seed('sos-hazard-layers', 'deploy-hazard-2', {
    hazard_id: 'deploy-hazard-2', title: 'Storm surge', event_type: 'storm', severity: 'critical', is_active: true,
    district: 'Hai Chau', geometry: { type: 'Point', coordinates: [108.2, 16.0] }, created_at: new Date().toISOString(),
  });
  const headers = headersFor('manager');
  const first = await (await fetch(`${baseUrl}/v1/hazards/deploy-hazard-2/deploy`, { method: 'POST', headers, body: JSON.stringify({}) })).json() as Data;
  const second = await (await fetch(`${baseUrl}/v1/hazards/deploy-hazard-2/deploy`, { method: 'POST', headers, body: JSON.stringify({}) })).json() as Data;
  assert.equal(first.event_id, second.event_id);
  assert.equal(first.eop_plan_id, second.eop_plan_id);
  assert.equal(second.idempotent, true);
  assert.equal(fake.entries('sos-emergency-events').filter((event) => event.metadata && (event.metadata as Data).hazard_id === 'deploy-hazard-2').length, 1);
  assert.equal(fake.read('sos-hazard-layers', 'deploy-hazard-2')?.linked_event_id, first.event_id);
});

test('expire-stale pages through hazards and reports scanned/updated', async () => {
  const old = new Date(Date.now() - 72 * 3600_000).toISOString();
  fake.seed('sos-hazard-layers', 'expire-old', { hazard_id: 'expire-old', title: 'Old', is_active: true, observed_at: old, created_at: old });
  fake.seed('sos-hazard-layers', 'expire-fresh', { hazard_id: 'expire-fresh', title: 'Fresh', is_active: true, observed_at: new Date().toISOString() });
  const response = await fetch(`${baseUrl}/v1/hazards/expire-stale`, { method: 'POST', headers: headersFor('manager'), body: JSON.stringify({ ttl_hours: 24 }) });
  assert.equal(response.status, 200);
  const body = await response.json() as Data;
  assert.ok(Number(body.scanned) > 0);
  assert.ok(Number(body.updated) >= 1);
  assert.equal(fake.read('sos-hazard-layers', 'expire-old')?.is_active, false);
  assert.equal(fake.read('sos-hazard-layers', 'expire-fresh')?.is_active, true);
});

// ── SITREP / AAR ────────────────────────────────────────────────────────────

test('SITREP validation, publish and delta revision (issue #16)', async () => {
  fake.seed('sos-emergency-events', 'sitrep-event', { id: 'sitrep-event', title: 'Flood', event_type: 'flood', severity: 'high', status: 'active', created_at: new Date().toISOString(), metadata: {} });
  const headers = headersFor('manager');

  const invalid = await fetch(`${baseUrl}/v1/emergency/sitrep`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json() as Data;
  assert.equal(invalidBody.error, 'sitrep_validation_failed');
  assert.ok(Array.isArray(invalidBody.details));

  const negative = await fetch(`${baseUrl}/v1/emergency/sitrep`, {
    method: 'POST', headers,
    body: JSON.stringify({
      emergency_event_id: 'sitrep-event', title: 'SITREP 1',
      reporting_period_start: new Date(Date.now() - 3600_000).toISOString(),
      reporting_period_end: new Date().toISOString(),
      casualties: -1,
    }),
  });
  assert.equal(negative.status, 400);

  const created = await fetch(`${baseUrl}/v1/emergency/sitrep`, {
    method: 'POST', headers,
    body: JSON.stringify({
      emergency_event_id: 'sitrep-event', title: 'SITREP 1',
      reporting_period_start: new Date(Date.now() - 3600_000).toISOString(),
      reporting_period_end: new Date().toISOString(),
      casualties: 2, snapshot: { summary: 'Flooding in ward 1' },
    }),
  });
  assert.equal(created.status, 201);
  const sitrep = await created.json() as Data;
  assert.equal(sitrep.author, 'qa-manager');
  assert.equal(sitrep.status, 'draft');

  const review = await fetch(`${baseUrl}/v1/emergency/sitrep/${sitrep.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ status: 'review_pending' }),
  });
  assert.equal(review.status, 200);
  const published = await fetch(`${baseUrl}/v1/emergency/sitrep/${sitrep.id}/publish`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(published.status, 200);
  assert.equal(((await published.json()) as Data).status, 'published');

  const mutated = await fetch(`${baseUrl}/v1/emergency/sitrep/${sitrep.id}`, { method: 'PUT', headers, body: JSON.stringify({ title: 'changed' }) });
  assert.equal(mutated.status, 409);

  const delta = await fetch(`${baseUrl}/v1/emergency/sitrep/${sitrep.id}/delta`, {
    method: 'POST', headers, body: JSON.stringify({ action_type: 'update', changes: { casualties: 3 } }),
  });
  assert.equal(delta.status, 201);
  const revision = await delta.json() as Data;
  assert.notEqual(revision.id, sitrep.id);
  assert.equal(revision.amends_sitrep_id, sitrep.id);
  assert.equal(revision.status, 'draft');
});

test('AAR computes real KPI/timeline and resolve creates exactly one draft (issue #16)', async () => {
  const start = Date.now() - 2 * 3600_000;
  fake.seed('sos-emergency-events', 'aar-event', {
    id: 'aar-event', event_code: 'EV-AAR', title: 'Flood AAR', event_type: 'flood', severity: 'high', status: 'active',
    created_at: new Date(start).toISOString(), started_at: new Date(start).toISOString(), metadata: {},
  });
  fake.seed('sos-dispatch-orders', 'aar-order-1', {
    id: 'aar-order-1', emergency_event_id: 'aar-event', task_title: 'Evacuate', status: 'completed', priority: 'high',
    assigned_resource_unit_id: 'aar-resource', created_at: new Date(start + 10 * 60_000).toISOString(),
    completed_at: new Date(start + 90 * 60_000).toISOString(), assignments: [{ assigned_resource_unit_id: 'aar-resource', assigned_at: new Date(start + 20 * 60_000).toISOString() }],
  });
  fake.seed('sos-dispatch-orders', 'aar-order-2', {
    id: 'aar-order-2', emergency_event_id: 'aar-event', task_title: 'Canceled', status: 'canceled', priority: 'low',
    created_at: new Date(start + 15 * 60_000).toISOString(), assignments: [],
  });
  fake.seed('sos-resource-units', 'aar-resource', { name: 'Team', resource_type: 'personnel', status: 'available' });
  fake.seed('sos-sitreps', 'aar-sitrep', {
    id: 'aar-sitrep', emergency_event_id: 'aar-event', title: 'SITREP', status: 'published',
    created_at: new Date(start + 30 * 60_000).toISOString(), published_at: new Date(start + 40 * 60_000).toISOString(),
  });

  const headers = headersFor('manager');
  const generated = await fetch(`${baseUrl}/v1/emergency/after-action/generate`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'aar-event' }),
  });
  assert.equal(generated.status, 201);
  const report = await generated.json() as Data;
  const kpi = report.kpi as Data;
  assert.ok((report.timeline as unknown[]).length >= 4);
  assert.ok(Number(kpi.response_time_minutes) > 0);
  assert.ok(Number(kpi.response_speed_score) > 0);
  assert.equal(kpi.dispatch_completion_rate, 100);
  assert.ok(Number(kpi.overall_score) > 0);
  assert.equal(kpi.dispatch_completed, 1);
  assert.equal(kpi.dispatch_canceled, 1);

  const resolved = await fetch(`${baseUrl}/v1/emergency/aar-event/resolve`, { method: 'POST', headers, body: JSON.stringify({ resolution_note: 'done' }) });
  assert.equal(resolved.status, 200);
  const resolvedBody = await resolved.json() as Data;
  assert.equal(resolvedBody.status, 'resolved');
  assert.ok(resolvedBody.after_action_report_id);

  const second = await fetch(`${baseUrl}/v1/emergency/aar-event/resolve`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as Data).after_action_report_id, resolvedBody.after_action_report_id);

  const forced = await fetch(`${baseUrl}/v1/emergency/after-action/generate`, {
    method: 'POST', headers, body: JSON.stringify({ emergency_event_id: 'aar-event', force_regenerate: true }),
  });
  assert.equal(forced.status, 201);
  assert.equal(((await forced.json()) as Data).version, 2);
});

// ── Public projection / SSE ─────────────────────────────────────────────────

test('public projection excludes terminal events and never exposes affected_asset_ids', async () => {
  fake.seed('sos-emergency-events', 'public-active', {
    id: 'public-active', title: 'Active', event_type: 'flood', severity: 'high', status: 'active',
    affected_asset_ids: ['asset-secret'], created_at: new Date().toISOString(), metadata: {},
  });
  fake.seed('sos-emergency-events', 'public-resolved', {
    id: 'public-resolved', title: 'Resolved', event_type: 'flood', severity: 'low', status: 'resolved',
    affected_asset_ids: ['asset-secret'], created_at: new Date().toISOString(), metadata: {},
  });
  const rows = await (await fetch(`${baseUrl}/v1/emergency/public`)).json() as Data[];
  assert.ok(rows.some((row) => row.id === 'public-active'));
  assert.ok(!rows.some((row) => row.id === 'public-resolved'));
  assert.ok(rows.every((row) => !('affected_asset_ids' in row)));
});

test('SSE emits a named error event instead of an empty snapshot on Tier-2 failure', async () => {
  fake.entitiesFail = true;
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/emergency/stream/hazards`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('event: error\n') && text.length < 20_000) {
      const chunk = await readWithTimeout(reader, 3000);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
    fake.entitiesFail = false;
  }
  assert.ok(text.includes('event: error\n'), `missing error frame: ${JSON.stringify(text)}`);
  assert.ok(!text.includes('"snapshot":[]'), 'must not synthesise an empty snapshot');
  assert.ok(text.includes('hazard_stream_degraded'));
});

test('SSE emits hazards frames and heartbeats when Tier-2 is healthy', async () => {
  fake.seed('sos-hazard-layers', 'stream-hazard-2', { hazard_id: 'stream-hazard-2', title: 'Landslide', is_active: true, observed_at: new Date().toISOString(), geometry: { type: 'Point', coordinates: [108, 16] } });
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/emergency/stream/hazards`, { signal: controller.signal });
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
  assert.ok(text.includes('event: hazards\n'));
  assert.ok(text.includes('retry: 5000'));
  assert.ok(!text.includes('\\n'), 'literal backslash-n leaked into the stream');
});

test('invalid bearer tokens are rejected on protected routes', async () => {
  const response = await fetch(`${baseUrl}/v1/emergency`, { headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(response.status, 401);
});

test('the six-role matrix is enforced on dispatch and EOP publish', async () => {
  fake.seed('sos-dispatch-orders', 'matrix-order', { emergency_event_id: 'e-matrix', task_title: 'Task', status: 'pending', assignments: [] });
  fake.seed('sos-resource-units', 'matrix-resource', { name: 'Team', resource_type: 'personnel', status: 'available' });
  fake.seed('sos-eop-plans', 'matrix-plan', { id: 'matrix-plan', emergency_event_id: 'e-matrix', title: 'Plan', status: 'approved', version: 1, actions: [] });

  // Read is allowed for every role.
  for (const role of ['citizen', 'volunteer', 'responder', 'operator', 'manager', 'admin'] as const) {
    const read = await fetch(`${baseUrl}/v1/emergency`, { headers: headersFor(role) });
    assert.equal(read.status, 200, `${role} must be able to read`);
  }

  const operatorApprove = await fetch(`${baseUrl}/v1/emergency/dispatch/matrix-order/approve`, {
    method: 'POST', headers: headersFor('operator'), body: JSON.stringify({ assigned_resource_unit_id: 'matrix-resource' }),
  });
  assert.equal(operatorApprove.status, 200, 'operator can dispatch');

  const operatorPublish = await fetch(`${baseUrl}/v1/emergency/eop/matrix-plan/publish`, {
    method: 'POST', headers: headersFor('operator'), body: JSON.stringify({}),
  });
  assert.equal(operatorPublish.status, 403, 'operator cannot publish EOP');

  const adminPublish = await fetch(`${baseUrl}/v1/emergency/eop/matrix-plan/publish`, {
    method: 'POST', headers: headersFor('admin'), body: JSON.stringify({}),
  });
  assert.equal(adminPublish.status, 200, 'admin can publish EOP');

  const citizenApprove = await fetch(`${baseUrl}/v1/emergency/dispatch/matrix-order/approve`, {
    method: 'POST', headers: headersFor('citizen'), body: JSON.stringify({ assigned_resource_unit_id: 'matrix-resource' }),
  });
  assert.equal(citizenApprove.status, 403);
});

test('markdown updates reject a stale if_version with 409', async () => {
  fake.seed('sos-eop-plans', 'version-plan', { id: 'version-plan', emergency_event_id: 'e-v', title: 'Plan', status: 'draft', version: 1, actions: [], markdown_body: '' });
  const headers = headersFor('manager');
  const stale = await fetch(`${baseUrl}/v1/emergency/eop/version-plan/markdown`, {
    method: 'PATCH', headers, body: JSON.stringify({ markdown_body: '# x', if_version: 999 }),
  });
  assert.equal(stale.status, 409);
  const ok = await fetch(`${baseUrl}/v1/emergency/eop/version-plan/markdown`, {
    method: 'PATCH', headers, body: JSON.stringify({ markdown_body: '# x', if_version: 1 }),
  });
  assert.equal(ok.status, 200);
});

test('public nearby shelters return distance and limited fields', async () => {
  fake.seed('sos-resource-units', 'shelter-near', {
    name: 'Shelter A', resource_code: 'S-A', resource_type: 'shelter', status: 'available',
    district: 'Hai Chau', capacity: 200, capacity_unit: 'người',
    current_location: { type: 'Point', coordinates: [104.1, 10.1] },
  });
  const response = await fetch(`${baseUrl}/v1/emergency/resources/shelters/near?lat=10&lng=104&radius_m=20000`);
  assert.equal(response.status, 200);
  const body = await response.json() as Data;
  const shelters = body.shelters as Data[];
  assert.ok(shelters.some((shelter) => shelter.id === 'shelter-near' && Number(shelter.distance_m) > 0));
});

test('AI status and chat use the Tier-2 capability and fail closed with a typed 503', async () => {
  resetAiStatusCache();
  const status = await (await fetch(`${baseUrl}/v1/ai/status`)).json() as Data;
  assert.equal(status.status, 'ok');
  assert.equal(status.configured, true);
  assert.equal(status.provider, 'tier-2-ai');
  assert.equal(status.model, 'fake-eop-model');

  const chat = await fetch(`${baseUrl}/v1/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(chat.status, 200);
  const chatBody = await chat.json() as Data;
  assert.equal(chatBody.provider, 'synapsedx');
  assert.ok(String(chatBody.content).includes('Kế hoạch'));

  const legacy = await fetch(`${baseUrl}/v1/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(legacy.status, 200, 'the legacy single-message body must still work');

  const invalid = await fetch(`${baseUrl}/v1/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }),
  });
  assert.equal(invalid.status, 400);

  const sosconn = await fetch(`${baseUrl}/v1/emergency/sosconn/status`, { headers: headersFor('manager') });
  assert.equal(sosconn.status, 200);
  const sosconnBody = await sosconn.json() as Data;
  assert.equal(sosconnBody.configured, true);
  assert.equal(sosconnBody.reachable, true);
  assert.equal(sosconnBody.status, 'ready');
  assert.equal(sosconnBody.model, 'fake-eop-model');

  fake.aiFail = true;
  resetAiStatusCache();
  try {
    const downStatus = await (await fetch(`${baseUrl}/v1/ai/status`)).json() as Data;
    assert.equal(downStatus.status, 'unavailable');
    assert.equal(downStatus.configured, false);

    const downChat = await fetch(`${baseUrl}/v1/ai/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }),
    });
    assert.equal(downChat.status, 503);
    assert.equal(((await downChat.json()) as Data).error, 'ai_capability_unavailable');

    const downConn = await (await fetch(`${baseUrl}/v1/emergency/sosconn/status`, { headers: headersFor('manager') })).json() as Data;
    assert.equal(downConn.configured, false);
    assert.equal(downConn.status, 'capability_unavailable');
  } finally {
    fake.aiFail = false;
    resetAiStatusCache();
  }

  const health = await fetch(`${baseUrl}/v1/emergency/health`, { headers: headersFor('manager') });
  assert.equal(health.status, 200);
  assert.ok(Array.isArray((await health.json() as Data).dependencies));
});

test('duplicate VNDMS records are upserted by stable hazard_id', async () => {
  const headers = headersFor('manager');
  const payload = {
    records: [
      { hazard_id: 'DUP-1', title: 'First', event_type: 'flood', lat: 10, lon: 104 },
      { hazard_id: 'DUP-1', title: 'Second', event_type: 'flood', lat: 10.01, lon: 104.01 },
    ],
  };
  const response = await fetch(`${baseUrl}/v1/hazards/ingest`, { method: 'POST', headers, body: JSON.stringify(payload) });
  assert.equal(response.status, 201);
  const rows = fake.entries('sos-hazard-layers').filter((row) => row.hazard_id === 'DUP-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Second');
});

// ── VNDMS connector status from the Tier-2 scheduled-jobs API (issue #13) ───

test('ingest status projects the Tier-2 scheduled connector instead of faking readiness (issue #13)', async () => {
  const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  fake.clearJobs();
  fake.seedJob(
    'vndms-connector',
    { name: 'VNDMS feed ingest', kind: 'ingest', schedule: { everySeconds: 300 }, payload: { source: 'vndms' } },
    [
      { id: 'run-2', status: 'success', startedAt: recent(6), finishedAt: recent(5), attempt: 1, lastError: null },
      { id: 'run-1', status: 'failed', startedAt: recent(12), finishedAt: recent(11), attempt: 1, lastError: 'upstream timeout' },
    ],
  );

  const status = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
  const connector = status.connector as Data;
  assert.equal(connector.source, 'tier-2-scheduled-job');
  assert.equal(connector.available, true);
  assert.equal(connector.configured, true);
  assert.equal(connector.job_id, 'vndms-connector');
  assert.equal(connector.job_name, 'VNDMS feed ingest');
  assert.equal(connector.enabled, true);
  assert.deepEqual(connector.schedule, { cron: null, every_seconds: 300 });
  assert.equal(connector.last_run_status, 'success');
  assert.equal(connector.runs_considered, 2);
  assert.ok(connector.last_success_at);
  assert.equal(status.status, 'ready');

  // The newest run failed: the connector is degraded, never "ready".
  fake.seedJob(
    'vndms-connector',
    { name: 'VNDMS feed ingest', kind: 'ingest', schedule: { everySeconds: 300 }, payload: { source: 'vndms' } },
    [{ id: 'run-3', status: 'failed', startedAt: recent(2), finishedAt: recent(1), attempt: 2, lastError: 'connection reset' }],
  );
  const degraded = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
  const degradedConnector = degraded.connector as Data;
  assert.equal(degradedConnector.last_run_status, 'failed');
  assert.equal(degradedConnector.last_run_error, 'connection reset');
  assert.equal(degradedConnector.error, 'connection reset');
  assert.equal(degraded.status, 'degraded');

  // A disabled job is reported as disabled, not as healthy.
  fake.seedJob('vndms-connector', { name: 'VNDMS feed ingest', enabled: false, schedule: { cron: '*/5 * * * *' } }, []);
  const disabled = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
  assert.equal((disabled.connector as Data).enabled, false);
  assert.equal((disabled.connector as Data).error, 'connector_disabled');

  // An unavailable jobs API is an explicit blocker, not a fake `ready`.
  fake.jobsFail = true;
  try {
    const down = await (await fetch(`${baseUrl}/v1/hazards/ingest/status`)).json() as Data;
    const downConnector = down.connector as Data;
    assert.equal(downConnector.available, false);
    assert.equal(downConnector.configured, false);
    assert.equal(downConnector.error, 'tier2_jobs_unreachable');
    assert.equal(down.status, 'degraded', 'a validated push keeps the data honest, but the missing connector is a degraded monitoring gap');
  } finally {
    fake.jobsFail = false;
    fake.clearJobs();
  }
});

// ── Tier-2 record version / ETag preconditions (issue #20) ───────────────────

test('record GETs expose the Tier-2 version as an ETag and updates honour If-Match (issue #20)', async () => {
  fake.seed('sos-eop-plans', 'etag-plan', { id: 'etag-plan', emergency_event_id: 'etag-event', title: 'Plan', status: 'draft', version: 1, actions: [], markdown_body: '', metadata: {} });
  const headers = headersFor('manager');

  const read = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan`, { headers });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('etag'), '"1"');
  assert.equal(read.headers.get('x-record-version'), '1');

  const updated = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan/markdown`, {
    method: 'PATCH', headers: { ...headers, 'if-match': '"1"' }, body: JSON.stringify({ markdown_body: '# v2' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get('etag'), '"2"');

  const stale = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan/markdown`, {
    method: 'PATCH', headers: { ...headers, 'if-match': '"1"' }, body: JSON.stringify({ markdown_body: '# lost update' }),
  });
  assert.equal(stale.status, 409, 'a stale If-Match must not overwrite the newer write');
  assert.equal(((await stale.json()) as Data).error, 'record_version_conflict');
  assert.equal(fake.read('sos-eop-plans', 'etag-plan')?.markdown_body, '# v2', 'the first write survives');

  const staleBody = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan/markdown`, {
    method: 'PATCH', headers, body: JSON.stringify({ markdown_body: '# stale body', if_version: 1 }),
  });
  assert.equal(staleBody.status, 409);
  const storedPlan = fake.read('sos-eop-plans', 'etag-plan') as Data;
  assert.equal('if_version' in storedPlan, false, 'a precondition must not be persisted as data');
  assert.equal('record_version' in storedPlan, false, 'the injected version must not be persisted as data');

  const mismatch = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan/markdown`, {
    method: 'PATCH', headers: { ...headers, 'if-match': '"2"' }, body: JSON.stringify({ markdown_body: '# x', if_version: 3 }),
  });
  assert.equal(mismatch.status, 400);
  assert.equal(((await mismatch.json()) as Data).error, 'version_precondition_mismatch');

  const invalid = await fetch(`${baseUrl}/v1/emergency/eop/etag-plan/markdown`, {
    method: 'PATCH', headers: { ...headers, 'if-match': 'not-a-version' }, body: JSON.stringify({ markdown_body: '# x' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as Data).error, 'invalid_if_match');
});

test('repeating the same dispatch approval is idempotent and writes no second assignment (issue #20)', async () => {
  fake.seed('sos-dispatch-orders', 'idem-order', { emergency_event_id: 'e-idem', task_title: 'Task', status: 'pending', assignments: [] });
  fake.seed('sos-resource-units', 'idem-resource', { name: 'Team Idem', resource_type: 'personnel', status: 'available' });
  const headers = headersFor('manager');

  const first = await fetch(`${baseUrl}/v1/emergency/dispatch/idem-order/approve`, {
    method: 'POST', headers, body: JSON.stringify({ assigned_resource_unit_id: 'idem-resource' }),
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json() as Data;
  assert.equal(firstBody.status, 'assigned');
  assert.equal((firstBody.assignments as unknown[]).length, 1);
  const versionAfterFirst = fake.recordVersion('sos-dispatch-orders', 'idem-order');

  const second = await fetch(`${baseUrl}/v1/emergency/dispatch/idem-order/approve`, {
    method: 'POST', headers, body: JSON.stringify({ assigned_resource_unit_id: 'idem-resource' }),
  });
  assert.equal(second.status, 200);
  const secondBody = await second.json() as Data;
  assert.equal(secondBody.idempotent, true);
  assert.equal((secondBody.assignments as unknown[]).length, 1);
  assert.equal(fake.recordVersion('sos-dispatch-orders', 'idem-order'), versionAfterFirst, 'an idempotent approval must not write again');
});

// ── Public projection source and publication state (issue #19) ───────────────

test('public projection comes from the Tier-2 publication API and omits unpublished records (issue #19)', async () => {
  fake.seed('sos-emergency-events', 'publication-visible', {
    id: 'publication-visible', title: 'Visible event', event_type: 'storm', severity: 'high', status: 'active',
    created_at: new Date().toISOString(), metadata: {},
  });
  fake.seed('sos-emergency-events', 'publication-hidden', {
    id: 'publication-hidden', title: 'Unpublished event', event_type: 'storm', severity: 'high', status: 'active',
    published: false, created_at: new Date().toISOString(), metadata: {},
  });

  const rows = await (await fetch(`${baseUrl}/v1/emergency/public`)).json() as Data[];
  assert.ok(rows.some((row) => row.id === 'publication-visible'));
  assert.ok(!rows.some((row) => row.id === 'publication-hidden'), 'a record with published:false must never appear publicly');

  // The entity/publication API is the only source: when it fails the endpoint
  // fails instead of quietly reading the private records collection.
  fake.entitiesFail = true;
  try {
    const failed = await fetch(`${baseUrl}/v1/emergency/public`);
    assert.equal(failed.status, 502);
  } finally {
    fake.entitiesFail = false;
  }
});

// ── SSE consumes the Tier-2 event feed (issue #19) ──────────────────────────

test('the hazard stream consumes Tier-2 events, supports Last-Event-ID and stops 30s list polling (issue #19)', async () => {
  fake.seed('sos-hazard-layers', 'stream-event-seed', {
    hazard_id: 'stream-event-seed', title: 'Seed hazard', is_active: true,
    observed_at: new Date().toISOString(), geometry: { type: 'Point', coordinates: [108, 16] },
  });
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/emergency/stream/hazards`, {
    headers: { 'last-event-id': 'cursor-0' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
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
    assert.ok(text.includes('"transport":"events"'), `initial frame must advertise the event transport: ${text}`);

    // A Tier-2 record write under the hazard dataset must reach the stream
    // through the event feed, without waiting for the old 30s list poll.
    await fake.records.create('sos-hazard-layers', {
      hazard_id: 'SSE-LIVE-1', title: 'Live hazard', is_active: true,
      geometry: { type: 'Point', coordinates: [108.1, 16.1] },
    }, { id: 'sse-live-1' });
    const before = text.length;
    const started = Date.now();
    while (!text.slice(before).includes('sse-live-1') && Date.now() - started < 6000) {
      const chunk = await readWithTimeout(reader, 3000);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const delta = text.slice(before);
    assert.ok(delta.includes('sse-live-1'), `the hazard delta must arrive from the event feed: ${delta}`);
    assert.ok(delta.includes('"source":"event"'), 'the delta frame must be marked as event-driven');
    assert.ok(fake.eventsQueries.some((query) => query.since === 'cursor-0'), 'the stream must resume from Last-Event-ID');
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
});

test('/metrics exposes request, dependency and product counters (issue #20)', async () => {
  const text = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.ok(text.includes('sos_request_total{route='));
  assert.ok(text.includes('sos_tier2_calls_total{dependency="synapsedx",result="ok"}'));
  assert.ok(text.includes('sos_eop_draft_total{source="tier2-ai"}'));
  assert.ok(text.includes('sos_hazard_stream_total{transport="event-feed"}'));
});
