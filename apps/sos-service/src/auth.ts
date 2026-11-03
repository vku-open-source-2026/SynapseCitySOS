// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseCity SOS auth shell.
 *
 * This module issues a stateless, HMAC-SHA256 signed session so the console
 * login/register/profile flows have a reachable API. It deliberately does not
 * store passwords or user records:
 *
 * - SOS responders remain `sos-resource-units`, never City users.
 * - There is no `/v1/users` namespace and no user dataset in this product.
 * - Production identity (password verification, MFA, account lifecycle) must
 *   be delegated to the Tier-1 IAM/API gateway. Until that integration exists,
 *   any non-empty username/password pair opens a shell session.
 *
 * Tokens are JWTs (HS256) with `typ: "access" | "refresh"`. If `AUTH_SECRET` is
 * not configured, an ephemeral secret is generated at start-up and a warning is
 * logged; all sessions become invalid when the process restarts.
 */
import { NextFunction, Request, Response, Router } from 'express';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type AuthUserRole = 'admin' | 'manager' | 'operator' | 'responder' | 'volunteer' | 'citizen';
export type AuthUserStatus = 'active' | 'inactive' | 'suspended';
export type SessionTokenType = 'access' | 'refresh';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone?: string;
  role: AuthUserRole;
  status?: AuthUserStatus;
  permissions?: string[];
  department?: string;
  avatar_url?: string;
  language?: string;
  last_login?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SessionClaims {
  sub: string;
  username: string;
  email: string;
  full_name: string;
  phone?: string;
  role: AuthUserRole;
  status: AuthUserStatus;
  permissions: string[];
  typ: SessionTokenType;
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: AuthUser;
}

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const ROLE_PERMISSIONS: Record<AuthUserRole, string[]> = {
  admin: ['emergency:read', 'emergency:write', 'emergency:dispatch', 'emergency:eop', 'emergency:admin'],
  manager: ['emergency:read', 'emergency:write', 'emergency:dispatch', 'emergency:eop'],
  operator: ['emergency:read', 'emergency:write', 'emergency:dispatch'],
  responder: ['emergency:read', 'emergency:write'],
  volunteer: ['emergency:read'],
  citizen: ['emergency:read'],
};

const ROLES = new Set<AuthUserRole>(['admin', 'manager', 'operator', 'responder', 'volunteer', 'citizen']);

function loadSecret(): { secret: string; ephemeral: boolean } {
  const configured = process.env.AUTH_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      console.warn('[synapsecity-sos] AUTH_SECRET is shorter than 32 characters; use a strong secret in production.');
    }
    return { secret: configured, ephemeral: false };
  }
  console.warn(
    '[synapsecity-sos] AUTH_SECRET is not set. Using an ephemeral session secret; sessions are invalidated on restart. ' +
      'Production identity must be delegated to the Tier-1 IAM gateway.',
  );
  return { secret: randomBytes(32).toString('hex'), ephemeral: true };
}

const SECRET = loadSecret();

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function header(): string {
  return base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
}

export function signSessionToken(
  claims: Omit<SessionClaims, 'typ' | 'iat' | 'exp' | 'jti'> & { typ: SessionTokenType; iat?: number; exp?: number; jti?: string },
  secret: string = SECRET.secret,
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const iat = claims.iat ?? nowSeconds;
  const ttl = claims.typ === 'access' ? ACCESS_TOKEN_TTL_SECONDS : REFRESH_TOKEN_TTL_SECONDS;
  const payload: SessionClaims = {
    ...claims,
    iat,
    exp: claims.exp ?? iat + ttl,
    jti: claims.jti ?? randomUUID(),
  };
  const encodedHeader = header();
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifySessionToken(
  token: string | null | undefined,
  expectedType: SessionTokenType,
  secret: string = SECRET.secret,
): SessionClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) return null;

  const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (!claims || claims.typ !== expectedType) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
  if (!claims.sub || !claims.username) return null;
  return claims;
}

export function isAuthUserRole(value: unknown): value is AuthUserRole {
  return typeof value === 'string' && ROLES.has(value as AuthUserRole);
}

function shellUser(input: {
  username: string;
  email?: string;
  full_name?: string;
  phone?: string;
  role?: AuthUserRole;
}): AuthUser {
  const role = isAuthUserRole(input.role) ? input.role : 'responder';
  const timestamp = new Date().toISOString();
  return {
    id: `sos-session-${randomUUID()}`,
    username: input.username,
    email: input.email || (input.username.includes('@') ? input.username : `${input.username}@sos.synapsecity.sbs`),
    full_name: input.full_name || input.username,
    phone: input.phone,
    role,
    status: 'active',
    permissions: ROLE_PERMISSIONS[role],
    language: 'vi',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function claimsFor(user: AuthUser, typ: SessionTokenType): Omit<SessionClaims, 'typ' | 'iat' | 'exp' | 'jti'> & { typ: SessionTokenType } {
  return {
    sub: user.id,
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    phone: user.phone,
    role: user.role,
    status: user.status || 'active',
    permissions: user.permissions || ROLE_PERMISSIONS[user.role],
    typ,
  };
}

function userFromClaims(claims: SessionClaims): AuthUser {
  return {
    id: claims.sub,
    username: claims.username,
    email: claims.email,
    full_name: claims.full_name,
    phone: claims.phone,
    role: claims.role,
    status: claims.status,
    permissions: claims.permissions,
    language: 'vi',
  };
}

export function issueSession(user: AuthUser): AuthResponse {
  return {
    access_token: signSessionToken(claimsFor(user, 'access')),
    refresh_token: signSessionToken(claimsFor(user, 'refresh')),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user,
  };
}

function tokenFromRequest(req: Request): string | null {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  // EventSource cannot set an Authorization header, so the SSE client appends
  // its access token as a query parameter.
  const queryToken = req.query.access_token;
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();
  return null;
}

export function sessionFromRequest(req: Request): SessionClaims | null {
  return verifySessionToken(tokenFromRequest(req), 'access');
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = sessionFromRequest(req);
  if (!session) {
    res.status(401).json({ detail: 'unauthorized', error: 'unauthorized' });
    return;
  }
  res.locals.session = session;
  next();
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function installAuthRoutes(app: import('express').Express): void {
  const router = Router();

  router.post('/login', (req, res) => {
    const username = stringField(req.body?.username);
    const password = stringField(req.body?.password);
    if (!username || !password) {
      res.status(400).json({ detail: 'username and password are required' });
      return;
    }
    const user = shellUser({
      username,
      email: stringField(req.body?.email) || undefined,
      full_name: stringField(req.body?.full_name) || undefined,
      phone: stringField(req.body?.phone) || undefined,
      role: req.body?.role,
    });
    res.json(issueSession(user));
  });

  router.post('/register', (req, res) => {
    const username = stringField(req.body?.username);
    const email = stringField(req.body?.email);
    const password = stringField(req.body?.password);
    const fullName = stringField(req.body?.full_name);
    if (!username || !email || !password || !fullName) {
      res.status(400).json({ detail: 'username, email, password and full_name are required' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ detail: 'email is not valid' });
      return;
    }
    // Registration is shell-only. No SOS user dataset or City user record is
    // created; the Tier-1 identity provider owns account lifecycle.
    const user = shellUser({
      username,
      email,
      full_name: fullName,
      phone: stringField(req.body?.phone) || undefined,
      role: req.body?.role,
    });
    res.status(201).json(issueSession(user));
  });

  router.post('/refresh', (req, res) => {
    const token = stringField(req.body?.refresh_token);
    const claims = verifySessionToken(token, 'refresh');
    if (!claims) {
      res.status(401).json({ detail: 'invalid_refresh_token' });
      return;
    }
    // Rotate both tokens. The user id is preserved for the new session shell.
    const user = userFromClaims({ ...claims, jti: randomUUID() });
    res.json(issueSession(user));
  });

  router.post('/logout', (_req, res) => {
    // Stateless tokens: logout clears the client store. A Tier-1 IAM gateway
    // can add a revocation list when production identity is delegated.
    res.status(204).end();
  });

  router.post('/change-password', requireSession, (req, res) => {
    const currentPassword = stringField(req.body?.current_password);
    const newPassword = stringField(req.body?.new_password);
    if (!currentPassword || !newPassword) {
      res.status(400).json({ detail: 'current_password and new_password are required' });
      return;
    }
    if (newPassword.length < 6) {
      res.status(400).json({ detail: 'new_password must be at least 6 characters' });
      return;
    }
    // The identity provider owns passwords. This shell endpoint intentionally
    // stores nothing and only acknowledges the request.
    res.status(204).end();
  });

  router.get('/me', requireSession, (_req, res) => {
    res.json(res.locals.session ? userFromClaims(res.locals.session as SessionClaims) : null);
  });

  router.get('/verify', requireSession, (_req, res) => {
    const session = res.locals.session as SessionClaims;
    res.json({
      valid: true,
      user: userFromClaims(session),
      expires_at: new Date(session.exp * 1000).toISOString(),
    });
  });

  app.use('/v1/auth', router);
}

export function authSecretIsEphemeral(): boolean {
  return SECRET.ephemeral;
}
