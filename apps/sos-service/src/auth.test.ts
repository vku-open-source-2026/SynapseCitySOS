// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCESS_TOKEN_TTL_SECONDS,
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
