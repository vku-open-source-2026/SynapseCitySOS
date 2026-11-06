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
 * - Production identity (password verification, MFA, account lifecycle) is
 *   delegated to the Tier-1 IAM/API gateway through the Tier-2 auth capability
 *   (`SOS_AUTH_MODE=tier2`, the default). The Tier-2 access/refresh tokens are
 *   carried inside the signed SOS session and are never returned as fields.
 *
 * Tokens are JWTs (HS256) with `typ: "access" | "refresh"`. If `AUTH_SECRET` is
 * not configured, an ephemeral secret is generated at start-up and a warning is
 * logged; all sessions become invalid when the process restarts.
 */
import { NextFunction, Request, Response, Router } from 'express';
import type { CapabilitiesClient, RequestOptions } from '@synapsedx/capabilities';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  assertIdentityConfiguration,
  authErrorStatus,
  bootstrapAdmins,
  configuredAuthMode,
  demoAuthAllowed,
  identityClient,
  isIdentityEmail,
  roleForIdentity,
  tier2ChangePassword,
  tier2Login,
  tier2Logout,
  tier2Refresh,
  tier2Register,
  type VerifiedIdentity,
} from './identity';

export type AuthUserRole = 'admin' | 'manager' | 'operator' | 'responder' | 'volunteer' | 'citizen';
export type AuthUserStatus = 'active' | 'inactive' | 'suspended';
export type SessionTokenType = 'access' | 'refresh';
export type AuthSource = 'tier2' | 'demo';

/**
 * Demo auth is an explicitly gated shell. It needs `SOS_AUTH_MODE=demo`,
 * `ALLOW_DEMO_AUTH=true` and a non-production `NODE_ENV`. When enabled it never
 * grants `admin`/`manager` from a client-supplied role: login becomes a
 * `responder` session and registration a read-only `volunteer` session.
 */
export function demoAuthEnabled(): boolean {
  return demoAuthAllowed();
}

export function assertAuthConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  assertIdentityConfiguration(env);
}

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
  /** Verified identity source; absent only on legacy demo-shell tokens. */
  auth_source?: AuthSource;
  /**
   * User-scoped Tier-2 credential minted/verified by the Tier-2 auth
   * capability. It is kept inside the signed SOS session and never returned to
   * the browser as a field; downstream Tier-2 calls forward it.
   */
  tier2_token?: string;
  /** Tier-2 refresh token, used only to rotate the delegated credential. */
  tier2_refresh_token?: string;
}

/** Server-side session extras. They are never serialized into an API body. */
export interface SessionExtras {
  auth_source?: AuthSource;
  tier2_token?: string;
  tier2_refresh_token?: string;
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

/** Demo sessions are never allowed to claim an operational/admin role. */
export function demoSessionRole(kind: 'login' | 'register'): AuthUserRole {
  const requested = process.env.SOS_DEMO_AUTH_ROLE;
  const safe: AuthUserRole = kind === 'register' ? 'volunteer' : 'responder';
  if (!requested || !isAuthUserRole(requested)) return safe;
  if (requested === 'admin' || requested === 'manager' || requested === 'operator') return safe;
  return requested;
}

export function rolePermissions(role: AuthUserRole): string[] {
  return [...(ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.citizen)];
}

export function hasPermission(session: Pick<SessionClaims, 'permissions' | 'role'> | null | undefined, permission: string): boolean {
  if (!session) return false;
  const permissions = Array.isArray(session.permissions) && session.permissions.length > 0
    ? session.permissions
    : rolePermissions(session.role);
  return permissions.includes(permission) || permissions.includes('emergency:admin');
}


function loadSecret(): { secret: string; ephemeral: boolean } {
  const configured = process.env.AUTH_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      console.warn('[synapsecity-sos] AUTH_SECRET is shorter than 32 characters; use a strong secret in production.');
    }
    return { secret: configured, ephemeral: false };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[synapsecity-sos] AUTH_SECRET must be set in production (an ephemeral secret would invalidate every session on restart)',
    );
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

  // Reject algorithm confusion and unsigned tokens before any HMAC work.
  try {
    const parsedHeader = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
    if (parsedHeader.alg !== 'HS256' || (parsedHeader.typ !== undefined && parsedHeader.typ !== 'JWT')) return null;
  } catch {
    return null;
  }

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

function claimsFor(
  user: AuthUser,
  typ: SessionTokenType,
  extras: SessionExtras = {},
): Omit<SessionClaims, 'typ' | 'iat' | 'exp' | 'jti'> & { typ: SessionTokenType } {
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
    ...(extras.auth_source ? { auth_source: extras.auth_source } : {}),
    ...(extras.tier2_token ? { tier2_token: extras.tier2_token } : {}),
    ...(extras.tier2_refresh_token ? { tier2_refresh_token: extras.tier2_refresh_token } : {}),
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

export function issueSession(user: AuthUser, extras: SessionExtras = {}): AuthResponse {
  return {
    access_token: signSessionToken(claimsFor(user, 'access', extras)),
    refresh_token: signSessionToken(claimsFor(user, 'refresh', extras)),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    user,
  };
}

/**
 * Build a session for an explicit role. Used by tests and by a future Tier-1
 * identity adapter after it has verified the upstream claims. It is not routed
 * and cannot be called by an HTTP client.
 */
export function issueSessionForRole(role: AuthUserRole, username = 'qa', permissions = rolePermissions(role)): AuthResponse {
  const user = shellUser({ username, role });
  user.permissions = permissions;
  return issueSession(user);
}


function tokenFromRequest(req: Request): string | null {
  const authorization = req.header('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  // Tokens are never accepted from a URL/query string: query tokens leak into
  // access logs, proxy traces and browser history (issue #17). The hazard SSE
  // stream is a public projection and needs no credential.
  return null;
}

export function sessionFromRequest(req: Request): SessionClaims | null {
  return validSession(verifySessionToken(tokenFromRequest(req), 'access'));
}

/**
 * Reject demo-shell sessions as soon as demo auth is no longer enabled. A
 * `tier2` session is always accepted; a token without `auth_source` can only
 * have come from the demo shell and is therefore refused outside demo mode.
 */
function validSession(claims: SessionClaims | null): SessionClaims | null {
  if (!claims) return null;
  if (claims.auth_source !== 'tier2' && !demoAuthAllowed()) return null;
  return claims;
}

/** Read the access token exactly as presented on the request. */
export function bearerTokenFromRequest(req: Request): string | null {
  return tokenFromRequest(req);
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

/**
 * Deny-by-default authorization on top of a validated session. Every mutation
 * route declares the permission it needs; a valid low-privilege session gets a
 * stable 403 instead of being able to dispatch/approve/publish (issue #21).
 */
export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = (res.locals.session as SessionClaims | undefined) ?? sessionFromRequest(req);
    if (!session) {
      res.status(401).json({ detail: 'unauthorized', error: 'unauthorized' });
      return;
    }
    if (!hasPermission(session, permission)) {
      res.status(403).json({ error: 'forbidden', required_permission: permission, role: session.role });
      return;
    }
    res.locals.session = session;
    next();
  };
}


function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The identifier a client sent: `email` first, then a legacy `username`. */
function identifierField(body: Record<string, unknown> | undefined): string {
  return stringField(body?.email) || stringField(body?.username);
}

/** Turn a verified Tier-2 identity into the SOS auth-user projection. */
function userFromIdentity(identity: VerifiedIdentity, role: AuthUserRole): AuthUser {
  const username = identity.email || identity.userId;
  const timestamp = new Date().toISOString();
  return {
    id: identity.userId,
    username,
    email: identity.email || `${identity.userId}@sos.synapsecity.sbs`,
    full_name: identity.displayName || username,
    role,
    status: 'active',
    permissions: rolePermissions(role),
    language: 'vi',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function identityForClaims(claims: Pick<SessionClaims, 'sub' | 'email' | 'full_name'>): Pick<VerifiedIdentity, 'userId' | 'email' | 'displayName'> {
  return { userId: claims.sub, email: claims.email, displayName: claims.full_name };
}

/** A failed password change means "wrong current password", not "bad login". */
function passwordChangeError(error: unknown): { status: number; code: string; detail: string } {
  const mapped = authErrorStatus(error);
  if (mapped.status === 401) {
    return { status: 401, code: 'invalid_current_password', detail: 'Current password is incorrect.' };
  }
  return mapped;
}

export interface AuthRouteOptions {
  /** Resolve the Tier-2 capability client for this request. */
  clientForRequest?: (req: Request) => CapabilitiesClient;
}

export function installAuthRoutes(app: import('express').Express, options: AuthRouteOptions = {}): void {
  const router = Router();
  const clientFor = options.clientForRequest ?? (() => identityClient());

  function demoGate(res: Response): boolean {
    if (demoAuthAllowed()) return true;
    res.status(403).json({
      error: 'demo_auth_disabled',
      detail: 'The SOS demo session shell is disabled. Configure SOS_AUTH_MODE=demo and ALLOW_DEMO_AUTH=true for a non-production demo, or use SOS_AUTH_MODE=tier2 (the Tier-2 auth capability).',
    });
    return false;
  }

  /**
   * `tier2` is the production path: credentials are verified by the Tier-2 auth
   * capability and the browser only ever receives the signed SOS session. The
   * client-supplied `role` is ignored in every mode.
   */
  router.post('/login', async (req, res) => {
    try {
      const password = stringField(req.body?.password);
      const identifier = identifierField(req.body);

      if (configuredAuthMode() === 'demo') {
        if (!demoGate(res)) return;
        const username = stringField(req.body?.username) || identifier;
        if (!identifier || !password) {
          res.status(400).json({ detail: 'username and password are required' });
          return;
        }
        const user = shellUser({
          username,
          email: stringField(req.body?.email) || undefined,
          full_name: stringField(req.body?.full_name) || undefined,
          phone: stringField(req.body?.phone) || undefined,
          role: demoSessionRole('login'),
        });
        res.json(issueSession(user, { auth_source: 'demo' }));
        return;
      }

      if (!identifier) {
        res.status(400).json({ error: 'email_required', detail: 'email and password are required' });
        return;
      }
      if (!isIdentityEmail(identifier)) {
        res.status(400).json({ error: 'email_required', detail: 'Tier-2 identity requires an email address.' });
        return;
      }
      if (!password) {
        res.status(400).json({ error: 'password_required', detail: 'email and password are required' });
        return;
      }

      const verified = await tier2Login(clientFor(req), {
        email: identifier.toLowerCase(),
        password,
        ...(stringField(req.body?.org_slug) ? { orgSlug: stringField(req.body?.org_slug) } : {}),
        correlationId: String(res.getHeader('x-correlation-id') || ''),
      });
      // The password was verified for this address; keep it as the role key so
      // the bootstrap allow-list still matches when Tier-2 omits `user.email`.
      const identity: VerifiedIdentity = { ...verified.identity, email: verified.identity.email || identifier.toLowerCase() };
      const role = roleForIdentity(identity);
      res.json(issueSession(userFromIdentity(identity, role), {
        auth_source: 'tier2',
        ...(verified.token ? { tier2_token: verified.token } : {}),
        ...(verified.refreshToken ? { tier2_refresh_token: verified.refreshToken } : {}),
      }));
    } catch (error) {
      const mapped = authErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code, detail: mapped.detail });
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const email = (stringField(req.body?.email) || stringField(req.body?.username)).toLowerCase();
      const password = stringField(req.body?.password);
      const fullName = stringField(req.body?.full_name) || stringField(req.body?.display_name);

      if (configuredAuthMode() === 'demo') {
        if (!demoGate(res)) return;
        if (!email || !password || !fullName) {
          res.status(400).json({ detail: 'email, password and full_name are required' });
          return;
        }
        if (!isIdentityEmail(email)) {
          res.status(400).json({ detail: 'email is not valid' });
          return;
        }
        // Registration is shell-only and read-only. No SOS user dataset or City
        // user record is created; Tier-1 owns account lifecycle and roles.
        const user = shellUser({
          username: stringField(req.body?.username) || email,
          email,
          full_name: fullName,
          phone: stringField(req.body?.phone) || undefined,
          role: demoSessionRole('register'),
        });
        res.status(201).json(issueSession(user, { auth_source: 'demo' }));
        return;
      }

      if (!email) {
        res.status(400).json({ error: 'email_required', detail: 'email, password and full_name are required' });
        return;
      }
      if (!isIdentityEmail(email)) {
        res.status(400).json({ error: 'email_invalid', detail: 'email is not valid' });
        return;
      }
      if (password.length < 6) {
        res.status(400).json({ error: 'password_too_short', detail: 'password must be at least 6 characters' });
        return;
      }
      if (!fullName) {
        res.status(400).json({ error: 'full_name_required', detail: 'full_name is required' });
        return;
      }

      const verified = await tier2Register(clientFor(req), {
        email,
        password,
        displayName: fullName,
        ...(stringField(req.body?.org_slug) ? { orgSlug: stringField(req.body?.org_slug) } : {}),
      });
      const identity: VerifiedIdentity = { ...verified.identity, email: verified.identity.email || email };
      // A new SOS account is a responder; only the operator-controlled
      // bootstrap allow-list can make it an administrator.
      const role = bootstrapAdmins().has(email) ? 'admin' : roleForIdentity(identity);
      res.status(201).json(issueSession(userFromIdentity(identity, role), {
        auth_source: 'tier2',
        ...(verified.token ? { tier2_token: verified.token } : {}),
        ...(verified.refreshToken ? { tier2_refresh_token: verified.refreshToken } : {}),
      }));
    } catch (error) {
      const mapped = authErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code, detail: mapped.detail });
    }
  });

  router.post('/refresh', async (req, res, next) => {
    try {
      const token = stringField(req.body?.refresh_token);
      const claims = verifySessionToken(token, 'refresh');
      if (!claims) {
        res.status(401).json({ detail: 'invalid_refresh_token' });
        return;
      }

      if (claims.auth_source === 'tier2') {
        if (!claims.tier2_refresh_token) {
          res.status(401).json({ error: 'invalid_refresh_token', detail: 'no Tier-2 refresh token in this session' });
          return;
        }
        try {
          const rotated = await tier2Refresh(clientFor(req), claims.tier2_refresh_token);
          // Re-derive the role so removing an email from the bootstrap
          // allow-list demotes the session on its next rotation.
          const role = roleForIdentity(identityForClaims(claims));
          const user: AuthUser = { ...userFromClaims(claims), role, permissions: rolePermissions(role) };
          res.json(issueSession(user, {
            auth_source: 'tier2',
            ...(rotated.accessToken || claims.tier2_token ? { tier2_token: rotated.accessToken || claims.tier2_token } : {}),
            tier2_refresh_token: rotated.refreshToken || claims.tier2_refresh_token,
          }));
        } catch (error) {
          const mapped = authErrorStatus(error);
          if (mapped.status === 401) {
            res.status(401).json({ error: 'invalid_refresh_token', detail: mapped.detail });
            return;
          }
          res.status(mapped.status).json({ error: mapped.code, detail: mapped.detail });
        }
        return;
      }

      // A token without a Tier-2 source came from the demo shell. It can only be
      // rotated while demo auth is still explicitly enabled.
      if (!demoAuthAllowed()) {
        res.status(401).json({ detail: 'invalid_refresh_token' });
        return;
      }
      const user = userFromClaims({ ...claims, jti: randomUUID() });
      res.json(issueSession(user, { auth_source: 'demo' }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (req, res) => {
    const access = sessionFromRequest(req);
    const refreshClaims = verifySessionToken(stringField(req.body?.refresh_token), 'refresh');
    const tier2RefreshToken = refreshClaims?.tier2_refresh_token || access?.tier2_refresh_token;
    if (tier2RefreshToken) {
      // Best-effort Tier-2/Tier-1 revocation; the stateless SOS session itself
      // is cleared by the console on this 204.
      try {
        await tier2Logout(clientFor(req), tier2RefreshToken);
      } catch (error) {
        console.warn('[synapsecity-sos] auth_logout_upstream_failed', (error as Error).message);
      }
    }
    res.status(204).end();
  });

  router.post('/change-password', requireSession, async (req, res) => {
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

    const session = res.locals.session as SessionClaims;
    if (session.auth_source === 'tier2' && session.tier2_token) {
      try {
        const correlationId = String(res.getHeader('x-correlation-id') || '');
        const requestOptions: RequestOptions = correlationId ? { correlationId } : {};
        await tier2ChangePassword(clientFor(req), currentPassword, newPassword, requestOptions);
        res.status(204).end();
      } catch (error) {
        const mapped = passwordChangeError(error);
        res.status(mapped.status).json({ error: mapped.code, detail: mapped.detail });
      }
      return;
    }
    if (demoAuthAllowed()) {
      // The demo shell stores nothing; it only acknowledges the request.
      res.status(204).end();
      return;
    }
    res.status(503).json({
      error: 'identity_not_configured',
      detail: 'Password changes require the Tier-2 identity capability.',
    });
  });

  router.get('/me', requireSession, (_req, res) => {
    res.json(res.locals.session ? userFromClaims(res.locals.session as SessionClaims) : null);
  });

  router.get('/verify', requireSession, (_req, res) => {
    const session = res.locals.session as SessionClaims;
    res.json({
      valid: true,
      user: userFromClaims(session),
      identity_source: session.auth_source || 'demo',
      expires_at: new Date(session.exp * 1000).toISOString(),
    });
  });

  app.use('/v1/auth', router);
}

export function authSecretIsEphemeral(): boolean {
  return SECRET.ephemeral;
}
