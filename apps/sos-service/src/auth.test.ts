// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  assertAuthConfiguration,
  demoSessionRole,
  hasPermission,
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from './auth';

const SECRET = 'test-secret-with-at-least-32-characters';

const base = {
  sub: 'sos-user-1',
  username: 'responder',
  email: 'responder@sos.synapsecity.sbs',
  full_name: 'Responder One',
  role: 'responder' as const,
  status: 'active' as const,
  permissions: ['emergency:read'],
};

test('access tokens round-trip and carry the auth user claims', () => {
  const token = signSessionToken({ ...base, typ: 'access' }, SECRET);
  const claims = verifySessionToken(token, 'access', SECRET);
  assert.ok(claims);
  assert.equal(claims.sub, base.sub);
  assert.equal(claims.username, base.username);
  assert.equal(claims.role, 'responder');
  assert.equal(claims.typ, 'access');
  assert.equal(claims.exp - claims.iat, ACCESS_TOKEN_TTL_SECONDS);
});

test('a refresh token is not accepted as an access token', () => {
  const refresh = signSessionToken({ ...base, typ: 'refresh' }, SECRET);
  assert.equal(verifySessionToken(refresh, 'access', SECRET), null);
  assert.ok(verifySessionToken(refresh, 'refresh', SECRET));
});

test('tampered signatures and malformed tokens are rejected', () => {
  const token = signSessionToken({ ...base, typ: 'access' }, SECRET);
  const [header, payload] = token.split('.');
  assert.equal(verifySessionToken(`${header}.${payload}.forged`, 'access', SECRET), null);
  assert.equal(verifySessionToken('not-a-token', 'access', SECRET), null);
  assert.equal(verifySessionToken(null, 'access', SECRET), null);
  assert.equal(verifySessionToken(token, 'access', 'different-secret-with-32-characters!!'), null);
});

test('algorithm confusion and unsigned tokens are rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ...base, typ: 'access', iat: now, exp: now + 60, jti: 'x' })).toString('base64url');
  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  assert.equal(verifySessionToken(`${noneHeader}.${payload}.`, 'access', SECRET), null);
  assert.equal(verifySessionToken(`${noneHeader}.${payload}.forged`, 'access', SECRET), null);
  assert.equal(verifySessionToken(`${hsHeader}.${payload}.forged`, 'access', SECRET), null);
});

test('expired tokens are rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = signSessionToken(
    { ...base, typ: 'access', iat: now - 120, exp: now - 60 },
    SECRET,
  );
  assert.equal(verifySessionToken(expired, 'access', SECRET), null);
});

test('claims expose a token id so refreshes rotate', () => {
  const first = verifySessionToken(signSessionToken({ ...base, typ: 'refresh' }, SECRET), 'refresh', SECRET);
  const second = verifySessionToken(signSessionToken({ ...base, typ: 'refresh' }, SECRET), 'refresh', SECRET);
  assert.ok(first && second);
  assert.notEqual((first as SessionClaims).jti, (second as SessionClaims).jti);
});

test('demo sessions never claim admin and ignore an operator env role', () => {
  const previous = process.env.SOS_DEMO_AUTH_ROLE;
  try {
    process.env.SOS_DEMO_AUTH_ROLE = 'admin';
    assert.equal(demoSessionRole('login'), 'responder');
    assert.equal(demoSessionRole('register'), 'volunteer');
    process.env.SOS_DEMO_AUTH_ROLE = 'operator';
    assert.equal(demoSessionRole('login'), 'responder');
    process.env.SOS_DEMO_AUTH_ROLE = 'volunteer';
    assert.equal(demoSessionRole('login'), 'volunteer');
  } finally {
    if (previous === undefined) delete process.env.SOS_DEMO_AUTH_ROLE;
    else process.env.SOS_DEMO_AUTH_ROLE = previous;
  }
});

test('production refuses demo auth at startup', () => {
  assert.throws(() => assertAuthConfiguration({ NODE_ENV: 'production', ALLOW_DEMO_AUTH: 'true' } as NodeJS.ProcessEnv), /refused in NODE_ENV=production/);
  assert.doesNotThrow(() => assertAuthConfiguration({ NODE_ENV: 'test', ALLOW_DEMO_AUTH: 'true' } as NodeJS.ProcessEnv));
  assert.doesNotThrow(() => assertAuthConfiguration({ NODE_ENV: 'production', ALLOW_DEMO_AUTH: 'false' } as NodeJS.ProcessEnv));
});

test('permissions follow the role matrix and admin is a wildcard', () => {
  assert.equal(hasPermission({ role: 'citizen', permissions: ['emergency:read'] }, 'emergency:dispatch'), false);
  assert.equal(hasPermission({ role: 'operator', permissions: ['emergency:read', 'emergency:dispatch'] }, 'emergency:dispatch'), true);
  assert.equal(hasPermission({ role: 'responder', permissions: ['emergency:read', 'emergency:write'] }, 'emergency:eop'), false);
  assert.equal(hasPermission({ role: 'admin', permissions: ['emergency:admin'] }, 'emergency:eop'), true);
});
