// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 identity adapter contract tests.
 *
 * A deterministic fake Tier-2 client stands in for `@synapsedx/capabilities`, so
 * these tests prove what SOS itself is responsible for: verifying through the
 * Tier-2 auth namespace, keeping the upstream token inside the signed session,
 * mapping roles safely and never trusting a client-supplied role.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { app } from './server';
import {
  assertAuthConfiguration,
  issueSessionForRole,
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from './auth';
import {
  configuredAuthMode,
  demoAuthAllowed,
  roleForIdentity,
  tier2AuthEnabled,
} from './identity';

type Data = Record<string, unknown>;

const ADMIN_EMAIL = 'chief@sos.test';
const RESPONDER_EMAIL = 'responder@sos.test';
const TIER2_ACCESS_PREFIX = 'tier2-access:';

class FakeTier2 {
  private readonly users = new Map<string, { id: string; email: string; password: string; displayName: string }>();
  private readonly datasetStore = new Map<string, Data>();
  private readonly recordStore = new Map<string, Map<string, Data>>();
  private readonly versions = new Map<string, number>();
  readonly refreshTokens = new Set<string>();
  readonly revokedRefreshTokens = new Set<string>();
  readonly passwordChanges: Array<{ current: string; next: string }> = [];
  loginCalls = 0;
  refreshCalls = 0;
  logoutCalls = 0;
  meCalls = 0;
  loginFailure: CapabilitiesError | null = null;
  /** Simulate a Tier-2 login response that omits `user.email`. */
  minimalLogin = false;
  meUser: Data = { id: 'user-min', email: RESPONDER_EMAIL };

  addUser(email: string, password: string, id = `user-${email.split('@')[0]}`): void {
    this.users.set(email.toLowerCase(), { id, email: email.toLowerCase(), password, displayName: `User ${id}` });
  }

  seed(datasetId: string, id: string, data: Data): void {
    let store = this.recordStore.get(datasetId);
    if (!store) { store = new Map(); this.recordStore.set(datasetId, store); }
    store.set(id, { ...data, id });
    this.versions.set(`${datasetId}:${id}`, 1);
    if (!this.datasetStore.has(datasetId)) this.datasetStore.set(datasetId, { id: datasetId, slug: datasetId, status: 'active', public: false });
  }

  private issue(email: string) {
    const user = this.users.get(email.toLowerCase());
    if (!user) throw new CapabilitiesError('user_not_found', { status: 404 });
    const accessToken = `${TIER2_ACCESS_PREFIX}${user.id}:${++this.loginCalls}`;
    const refreshToken = `tier2-refresh:${user.id}:${this.loginCalls}`;
    this.refreshTokens.add(refreshToken);
    return {
      accessToken,
      refreshToken,
      expiresIn: 900,
      user: { id: user.id, email: user.email, display_name: user.displayName },
    };
  }

  private row(datasetId: string, id: string): Data {
    const found = this.recordStore.get(datasetId)?.get(id);
    if (!found) throw new CapabilitiesError('not_found', { status: 404 });
    return { id, data: found, version: this.versions.get(`${datasetId}:${id}`) ?? 1 };
  }

  readonly auth = {
    login: async (input: { email: string; password: string }) => {
      if (this.loginFailure) throw this.loginFailure;
      const user = this.users.get(input.email.toLowerCase());
      if (!user || user.password !== input.password) {
        throw new CapabilitiesError('invalid_credentials', { status: 401 });
      }
      const session = this.issue(input.email);
      return this.minimalLogin ? { ...session, user: { id: session.user.id } } : session;
    },
    register: async (input: { email: string; password: string; displayName?: string }) => {
      if (this.users.has(input.email.toLowerCase())) {
        throw new CapabilitiesError('identity_conflict', { status: 409 });
      }
      this.users.set(input.email.toLowerCase(), {
        id: `user-${input.email.split('@')[0]}`,
        email: input.email.toLowerCase(),
        password: input.password,
        displayName: input.displayName || input.email,
      });
      return this.issue(input.email);
    },
    refresh: async (refreshToken: string) => {
      this.refreshCalls += 1;
      if (!this.refreshTokens.has(refreshToken) || this.revokedRefreshTokens.has(refreshToken)) {
        throw new CapabilitiesError('invalid_refresh_token', { status: 401 });
      }
      const [, userId] = refreshToken.split(':');
      const user = [...this.users.values()].find((entry) => entry.id === userId);
      if (!user) throw new CapabilitiesError('invalid_refresh_token', { status: 401 });
      this.refreshTokens.delete(refreshToken);
      const accessToken = `${TIER2_ACCESS_PREFIX}${user.id}:rotated`;
      const next = `tier2-refresh:${user.id}:rotated-${this.refreshCalls}`;
      this.refreshTokens.add(next);
      return { accessToken, refreshToken: next, expiresIn: 900 };
    },
    logout: async (refreshToken: string) => {
      this.logoutCalls += 1;
      this.revokedRefreshTokens.add(refreshToken);
      return { ok: true };
    },
    changePassword: async (current: string, next: string) => {
      this.passwordChanges.push({ current, next });
      if (current === 'wrong-password') throw new CapabilitiesError('invalid_credentials', { status: 401 });
      return { ok: true, revokedSessions: 1 };
    },
    me: async () => {
      this.meCalls += 1;
      return { kind: 'user', user: this.meUser };
    },
    exchange: async () => {
      // Mirrors a deployment whose service credential cannot mint tokens.
      throw new CapabilitiesError('exchange_forbidden', { status: 403 });
    },
  };

  readonly datasets = {
    get: async (id: string) => {
      const found = this.datasetStore.get(id);
      if (!found) throw new CapabilitiesError('not_found', { status: 404 });
      return found;
    },
    create: async (input: Data) => {
      const id = String(input.slug ?? input.id);
      const created = { ...input, id, status: input.public === true ? 'published' : 'active' };
      this.datasetStore.set(id, created);
      return created;
    },
    publish: async (id: string) => {
      const found = await this.datasets.get(id);
      const published = { ...found, status: 'published' };
      this.datasetStore.set(id, published);
      return published;
    },
    entities: async () => [],
  };

  readonly records = {
    list: async (datasetId: string, query: { limit?: number; offset?: number } = {}) => {
      const store = this.recordStore.get(datasetId);
      const items = [...(store?.keys() ?? [])].map((id) => this.row(datasetId, id));
      const offset = Number(query.offset) || 0;
      const limit = Number(query.limit) || 100;
      return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
    },
    get: async (datasetId: string, id: string) => this.row(datasetId, id),
    create: async (datasetId: string, data: Data) => {
      const id = String(data.id);
      this.seed(datasetId, id, data);
      return this.row(datasetId, id);
    },
    update: async (datasetId: string, id: string, data: Data) => {
      const current = this.recordStore.get(datasetId)?.get(id);
      if (!current) throw new CapabilitiesError('not_found', { status: 404 });
      this.recordStore.get(datasetId)?.set(id, { ...current, ...data, id });
      this.versions.set(`${datasetId}:${id}`, (this.versions.get(`${datasetId}:${id}`) ?? 1) + 1);
      return this.row(datasetId, id);
    },
    delete: async () => undefined,
  };

  health = async () => ({ status: 'ok' });

  asClient(): CapabilitiesClient {
    return this as unknown as CapabilitiesClient;
  }
}

const fake = new FakeTier2();
let server: Server;
let baseUrl: string;
const savedEnv: NodeJS.ProcessEnv = {};

before(async () => {
  for (const key of ['SOS_AUTH_MODE', 'ALLOW_DEMO_AUTH', 'SOS_BOOTSTRAP_ADMIN_EMAILS', 'SOS_AUTH_DEFAULT_ROLE', 'SOS_AUTH_EXCHANGE', 'NODE_ENV']) {
    savedEnv[key] = process.env[key];
  }
  process.env.SOS_AUTH_MODE = 'tier2';
  delete process.env.ALLOW_DEMO_AUTH;
  delete process.env.SOS_AUTH_EXCHANGE;
  delete process.env.SOS_AUTH_DEFAULT_ROLE;
  process.env.SOS_BOOTSTRAP_ADMIN_EMAILS = ` ${ADMIN_EMAIL} , ops@sos.test `;

  fake.addUser(RESPONDER_EMAIL, 'correct-horse');
  fake.addUser(ADMIN_EMAIL, 'admin-horse');
  fake.addUser('ops@sos.test', 'ops-horse');
  fake.seed('sos-eop-plans', 'plan-1', { id: 'plan-1', emergency_event_id: 'e-1', title: 'Plan', status: 'approved', version: 1, actions: [] });

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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function post(path: string, body: Data, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function login(email: string, password: string, extra: Data = {}) {
  const response = await post('/v1/auth/login', { email, password, ...extra });
  assert.equal(response.status, 200, `${email} must be able to log in through Tier-2`);
  return await response.json() as { access_token: string; refresh_token: string; user: Data };
}

function claimsOf(token: string): SessionClaims {
  const claims = verifySessionToken(token, 'access');
  assert.ok(claims, 'the SOS session token must verify');
  return claims;
}

// ── Mode configuration ─────────────────────────────────────────────────────

test('Tier-2 is the default identity mode and demo needs an explicit triple opt-in', () => {
  const saved = {
    mode: process.env.SOS_AUTH_MODE,
    alias: process.env.AUTH_MODE,
    demo: process.env.ALLOW_DEMO_AUTH,
    node: process.env.NODE_ENV,
  };
  try {
    delete process.env.SOS_AUTH_MODE;
    delete process.env.AUTH_MODE;
    delete process.env.ALLOW_DEMO_AUTH;
    assert.equal(configuredAuthMode(), 'tier2');
    assert.equal(tier2AuthEnabled(), true);
    assert.equal(demoAuthAllowed(), false);

    process.env.SOS_AUTH_MODE = 'demo';
    assert.equal(demoAuthAllowed(), false, 'demo mode alone must not enable the demo shell');

    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.NODE_ENV = 'test';
    assert.equal(demoAuthAllowed(), true);

    process.env.NODE_ENV = 'production';
    assert.equal(demoAuthAllowed(), false, 'production must refuse the demo shell');
    assert.throws(() => assertAuthConfiguration(process.env), /refused in NODE_ENV=production/);

    process.env.SOS_AUTH_MODE = 'tier2';
    process.env.ALLOW_DEMO_AUTH = 'false';
    assert.doesNotThrow(() => assertAuthConfiguration(process.env));
  } finally {
    for (const [key, value] of [
      ['SOS_AUTH_MODE', saved.mode],
      ['AUTH_MODE', saved.alias],
      ['ALLOW_DEMO_AUTH', saved.demo],
      ['NODE_ENV', saved.node],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('an unknown auth mode never enables demo', () => {
  const saved = process.env.SOS_AUTH_MODE;
  try {
    process.env.SOS_AUTH_MODE = 'true';
    assert.equal(configuredAuthMode(), 'tier2');
    process.env.SOS_AUTH_MODE = 'DEMO';
    assert.equal(configuredAuthMode(), 'demo');
  } finally {
    if (saved === undefined) delete process.env.SOS_AUTH_MODE;
    else process.env.SOS_AUTH_MODE = saved;
  }
});

// ── Login ──────────────────────────────────────────────────────────────────

test('login with an email/password is verified by Tier-2 and hidden inside the SOS session', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse', { role: 'admin' });
  assert.equal(session.user.role, 'responder', 'a normal Tier-2 account is a responder');
  assert.deepEqual(session.user.permissions, ['emergency:read', 'emergency:write']);
  assert.equal(session.user.email, RESPONDER_EMAIL);
  assert.ok(session.user.id);

  // The Tier-2 credential is carried inside the signed session only; the API
  // body must never contain it as a field.
  const claims = claimsOf(session.access_token);
  assert.equal(claims.auth_source, 'tier2');
  assert.match(String(claims.tier2_token), /^tier2-access:/);
  assert.ok(claims.tier2_refresh_token);
  const body = JSON.stringify(session);
  assert.ok(!body.includes(claims.tier2_token as string), 'the Tier-2 access token must not be returned');
  assert.ok(!body.includes(String(claims.tier2_refresh_token)), 'the Tier-2 refresh token must not be returned');
  assert.ok(!('tier2_token' in session.user));
});

test('a login response without an email is completed through the Tier-2 auth.me capability', async () => {
  const calls = fake.meCalls;
  fake.minimalLogin = true;
  try {
    const session = await login(RESPONDER_EMAIL, 'correct-horse');
    assert.equal(fake.meCalls, calls + 1, 'the adapter asks Tier-2 auth.me for the missing identity fields');
    assert.equal(session.user.email, RESPONDER_EMAIL);
    assert.equal(session.user.role, 'responder');
  } finally {
    fake.minimalLogin = false;
  }
});

test('login rejects a wrong password, a non-email identifier and an unavailable capability', async () => {
  const wrong = await post('/v1/auth/login', { email: RESPONDER_EMAIL, password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: 'invalid_credentials', detail: 'Email or password is incorrect.' });

  const usernameOnly = await post('/v1/auth/login', { username: 'responder', password: 'correct-horse' });
  assert.equal(usernameOnly.status, 400);
  assert.equal(((await usernameOnly.json()) as Data).error, 'email_required');

  fake.loginFailure = new CapabilitiesError('unauthorized', { status: 503 });
  try {
    const unavailable = await post('/v1/auth/login', { email: RESPONDER_EMAIL, password: 'correct-horse' });
    assert.equal(unavailable.status, 503);
    assert.equal(((await unavailable.json()) as Data).error, 'identity_not_configured');
  } finally {
    fake.loginFailure = null;
  }
});

test('the client-supplied role is never trusted, in the body or in the session', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse', { role: 'admin', permissions: ['emergency:admin'] });
  const claims = claimsOf(session.access_token);
  assert.equal(claims.role, 'responder');
  assert.deepEqual(claims.permissions, ['emergency:read', 'emergency:write']);
});

// ── Role mapping / authorization ───────────────────────────────────────────

test('only the server-side bootstrap allow-list grants admin', () => {
  assert.equal(roleForIdentity({ userId: 'u1', email: 'nobody@sos.test' }), 'responder');
  assert.equal(roleForIdentity({ userId: 'u2', email: ADMIN_EMAIL.toUpperCase() }), 'admin');
  assert.equal(roleForIdentity({ userId: 'u3', email: 'ops@sos.test' }), 'admin');
});

test('a responder is refused on a privileged route while the bootstrap admin succeeds', async () => {
  const responder = await login(RESPONDER_EMAIL, 'correct-horse');
  const responderPublish = await post('/v1/emergency/eop/plan-1/publish', {}, responder.access_token);
  assert.equal(responderPublish.status, 403);
  assert.equal(((await responderPublish.json()) as Data).required_permission, 'emergency:eop');

  const admin = await login(ADMIN_EMAIL, 'admin-horse');
  assert.equal(admin.user.role, 'admin');
  assert.ok((admin.user.permissions as string[]).includes('emergency:admin'));
  const adminPublish = await post('/v1/emergency/eop/plan-1/publish', {}, admin.access_token);
  assert.equal(adminPublish.status, 200, 'the bootstrap admin may publish an approved EOP');
  assert.equal(((await adminPublish.json()) as Data).status, 'published');
});

// ── Register ───────────────────────────────────────────────────────────────

test('registration creates a responder account unless the email is a bootstrap admin', async () => {
  const created = await post('/v1/auth/register', {
    email: 'new.responder@sos.test', password: 'secret1', full_name: 'New Responder', role: 'admin',
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { user: Data };
  assert.equal(createdBody.user.role, 'responder', 'self-registration cannot grant a role');
  assert.ok(!(createdBody.user.permissions as string[]).includes('emergency:admin'));

  const adminCreated = await post('/v1/auth/register', {
    email: 'second.chief@sos.test', password: 'secret1', full_name: 'Second Chief',
  });
  assert.equal(adminCreated.status, 201);
  assert.equal(((await adminCreated.json()) as { user: Data }).user.role, 'responder', 'only configured emails are admins');

  process.env.SOS_BOOTSTRAP_ADMIN_EMAILS = `${ADMIN_EMAIL},ops@sos.test,bootstrap.new@sos.test`;
  try {
    const bootstrapped = await post('/v1/auth/register', {
      email: 'bootstrap.new@sos.test', password: 'secret1', full_name: 'Bootstrap', role: 'responder',
    });
    assert.equal(bootstrapped.status, 201);
    assert.equal(((await bootstrapped.json()) as { user: Data }).user.role, 'admin');
  } finally {
    process.env.SOS_BOOTSTRAP_ADMIN_EMAILS = ` ${ADMIN_EMAIL} , ops@sos.test `;
  }

  const duplicate = await post('/v1/auth/register', {
    email: RESPONDER_EMAIL, password: 'secret1', full_name: 'Duplicate',
  });
  assert.equal(duplicate.status, 409);

  const invalid = await post('/v1/auth/register', { email: 'not-an-email', password: 'secret1', full_name: 'X' });
  assert.equal(invalid.status, 400);
});

// ── Refresh / logout / password change ─────────────────────────────────────

test('refresh rotates both the SOS session and the Tier-2 credential', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse');
  const before = claimsOf(session.access_token);
  const calls = fake.refreshCalls;

  const response = await post('/v1/auth/refresh', { refresh_token: session.refresh_token });
  assert.equal(response.status, 200);
  const rotated = await response.json() as { access_token: string; refresh_token: string; user: Data };
  assert.notEqual(rotated.access_token, session.access_token);
  assert.notEqual(rotated.refresh_token, session.refresh_token);
  assert.equal(fake.refreshCalls, calls + 1, 'Tier-2 must be asked to rotate the credential');
  assert.equal(rotated.user.role, 'responder');

  const after = claimsOf(rotated.access_token);
  assert.equal(after.auth_source, 'tier2');
  assert.notEqual(after.tier2_token, before.tier2_token);
  assert.ok(!fake.refreshTokens.has(String(before.tier2_refresh_token)), 'the rotated Tier-2 refresh token is retired');
});

test('refresh refuses tokens that did not come from Tier-2 while demo auth is off', async () => {
  const legacy = issueSessionForRole('responder', 'legacy').refresh_token;
  const response = await post('/v1/auth/refresh', { refresh_token: legacy });
  assert.equal(response.status, 401);

  const demoClaims = {
    sub: 'demo-1', username: 'demo', email: 'demo@sos.test', full_name: 'Demo',
    role: 'responder' as const, status: 'active' as const, permissions: ['emergency:read'],
    auth_source: 'demo' as const,
  };
  const demoRefresh = signSessionToken({ ...demoClaims, typ: 'refresh' });
  assert.equal((await post('/v1/auth/refresh', { refresh_token: demoRefresh })).status, 401);

  // A demo-shell access token cannot open an emergency route either.
  const demoAccess = signSessionToken({ ...demoClaims, typ: 'access' });
  const protectedResponse = await fetch(`${baseUrl}/v1/emergency`, { headers: { authorization: `Bearer ${demoAccess}` } });
  assert.equal(protectedResponse.status, 401);
});

test('logout revokes the Tier-2 refresh token and clears the shell', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse');
  const claims = claimsOf(session.access_token);
  const before = fake.logoutCalls;

  const response = await post('/v1/auth/logout', { refresh_token: session.refresh_token }, session.access_token);
  assert.equal(response.status, 204);
  assert.equal(fake.logoutCalls, before + 1, 'Tier-2 best-effort logout must be attempted');
  assert.ok(fake.revokedRefreshTokens.has(String(claims.tier2_refresh_token)));

  const reuse = await post('/v1/auth/refresh', { refresh_token: session.refresh_token });
  assert.equal(reuse.status, 401, 'a revoked refresh token cannot reopen a session');
});

test('password change is delegated to Tier-2 and reports a wrong current password', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse');
  const ok = await post('/v1/auth/change-password', {
    current_password: 'correct-horse', new_password: 'new-secret',
  }, session.access_token);
  assert.equal(ok.status, 204);
  assert.deepEqual(fake.passwordChanges.at(-1), { current: 'correct-horse', next: 'new-secret' });

  const wrong = await post('/v1/auth/change-password', {
    current_password: 'wrong-password', new_password: 'new-secret',
  }, session.access_token);
  assert.equal(wrong.status, 401);
  assert.equal(((await wrong.json()) as Data).error, 'invalid_current_password');
});

test('me returns the SOS session user without the upstream credential', async () => {
  const session = await login(RESPONDER_EMAIL, 'correct-horse');
  const response = await fetch(`${baseUrl}/v1/auth/me`, { headers: { authorization: `Bearer ${session.access_token}` } });
  assert.equal(response.status, 200);
  const me = await response.json() as Data;
  assert.equal(me.email, RESPONDER_EMAIL);
  assert.equal(me.role, 'responder');
  assert.ok(!JSON.stringify(me).includes(TIER2_ACCESS_PREFIX));
});

// ── Production demo refusal ────────────────────────────────────────────────

test('the demo login route stays refused in production even when the mode is demo', async () => {
  const saved = { mode: process.env.SOS_AUTH_MODE, demo: process.env.ALLOW_DEMO_AUTH, node: process.env.NODE_ENV };
  try {
    process.env.SOS_AUTH_MODE = 'demo';
    process.env.ALLOW_DEMO_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    const response = await post('/v1/auth/login', { username: 'demo', password: 'demo' });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as Data).error, 'demo_auth_disabled');
  } finally {
    for (const [key, value] of [['SOS_AUTH_MODE', saved.mode], ['ALLOW_DEMO_AUTH', saved.demo], ['NODE_ENV', saved.node]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
