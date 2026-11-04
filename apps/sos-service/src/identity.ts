// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { CapabilitiesClient, CapabilitiesError, type RequestOptions } from '@synapsedx/capabilities';
import type { AuthUserRole } from './auth';

/**
 * Identity boundary: Tier-2 auth capability -> SOS session shell.
 *
 * The SOS service never stores credentials, password hashes or an identity
 * table. In `tier2` mode (the default and the only production path)
 * credentials are verified by the Tier-2 `auth.login`/`auth.register`
 * capability, which proxies the Tier-1 IAM service. SOS then issues its own
 * short-lived signed session so the browser never receives a Tier-1 token.
 *
 * Roles are never taken from the request body or from an unverified claim. A
 * verified identity is mapped to an SOS role using the server-side bootstrap
 * allow-list (`SOS_BOOTSTRAP_ADMIN_EMAILS`); everything else gets
 * `SOS_AUTH_DEFAULT_ROLE` (default `responder`). Responders are resource units,
 * not City users: SOS has no user dataset and never reads `city-users`.
 *
 * `demo` mode is an explicit development-only shell. It is honoured only when
 * `SOS_AUTH_MODE=demo` **and** `ALLOW_DEMO_AUTH=true` outside production, and
 * `NODE_ENV=production` refuses to start with it.
 *
 * Dependency: https://github.com/vku-open-source-2026/SynapseDX/issues/8
 */

export const IDENTITY_DEPENDENCY = 'https://github.com/vku-open-source-2026/SynapseDX/issues/8';

export type AuthMode = 'tier2' | 'demo';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The only accepted identifier for Tier-2 identity is an email address. */
export function isIdentityEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Configured identity mode. `tier2` is the default for every environment,
 * including production; an unknown value never silently enables demo.
 */
export function configuredAuthMode(): AuthMode {
  const raw = (process.env.SOS_AUTH_MODE ?? process.env.AUTH_MODE ?? '').trim().toLowerCase();
  return raw === 'demo' ? 'demo' : 'tier2';
}

/**
 * Demo auth is a development-only shell: it needs an explicit
 * `SOS_AUTH_MODE=demo`, the `ALLOW_DEMO_AUTH=true` opt-in and a non-production
 * `NODE_ENV`. Anything else falls back to refusing the demo routes.
 */
export function demoAuthAllowed(): boolean {
  return configuredAuthMode() === 'demo'
    && process.env.ALLOW_DEMO_AUTH === 'true'
    && process.env.NODE_ENV !== 'production';
}

/** True when the Tier-2 auth capability is the configured identity source. */
export function tier2AuthEnabled(): boolean {
  return configuredAuthMode() === 'tier2';
}

export function assertIdentityConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.ALLOW_DEMO_AUTH === 'true') {
    throw new Error('ALLOW_DEMO_AUTH=true is refused in NODE_ENV=production; obtain identity from the Tier-2 auth capability');
  }
  const mode = String(env.SOS_AUTH_MODE ?? env.AUTH_MODE ?? '').trim().toLowerCase();
  if (env.NODE_ENV === 'production' && mode === 'demo') {
    throw new Error('SOS_AUTH_MODE=demo is refused in NODE_ENV=production; use SOS_AUTH_MODE=tier2 (Tier-2 auth capability -> Tier-1 IAM)');
  }
}

export function identityCapabilityStatus(): Record<string, unknown> {
  if (tier2AuthEnabled()) {
    return {
      status: 'available',
      mode: 'tier2',
      transport: 'synapsedx',
      provider: 'tier-2-auth-capability -> tier-1-iam',
      detail: 'Credentials are verified by the Tier-2 auth capability. Roles come from the server-side bootstrap allow-list/default role, never from the client.',
      exchange: exchangeEnabled() ? 'enabled' : 'optional',
    };
  }
  return {
    status: demoAuthAllowed() ? 'demo' : 'disabled',
    mode: 'demo',
    detail: 'Development-only demo session shell. Never enable this on an Internet-facing deployment.',
    dependency: IDENTITY_DEPENDENCY,
  };
}

/** Optional delegated-token exchange (service credential -> user-scoped token). */
export function exchangeEnabled(): boolean {
  const raw = (process.env.SOS_AUTH_EXCHANGE || '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export function exchangeScopes(): string[] {
  const raw = (process.env.SOS_AUTH_EXCHANGE_SCOPES || 'read,write').trim();
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const BOOTSTRAP_ADMIN_ENV = 'SOS_BOOTSTRAP_ADMIN_EMAILS';

/** Server-side bootstrap allow-list. Never read from a request body. */
export function bootstrapAdmins(): Set<string> {
  return new Set(
    (process.env[BOOTSTRAP_ADMIN_ENV] || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface VerifiedIdentity {
  userId: string;
  email: string;
  displayName: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /**
   * Scopes carried by the *Tier-2/Tier-1* credential. They are informational:
   * SOS authorization is derived from its own role mapping, not from scopes.
   */
  scopes: string[];
  raw: Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scopesOf(raw: Record<string, unknown>): string[] {
  const scopes = raw.scopes;
  if (Array.isArray(scopes)) return scopes.map(String).filter(Boolean);
  return [];
}

/** Normalize the Tier-2 `auth.login`/`auth.register`/`auth.me` response. */
export function identityFromSession(session: Record<string, unknown>): VerifiedIdentity {
  const accessToken = stringValue(session.accessToken || session.access_token);
  const refreshToken = stringValue(session.refreshToken || session.refresh_token);
  const user = (session.user && typeof session.user === 'object' ? session.user : {}) as Record<string, unknown>;
  const email = stringValue(user.email) || stringValue(session.email);
  const userId = stringValue(user.id) || stringValue(user.sub) || stringValue(session.userId) || stringValue(session.sub);
  if (!userId && !email) throw Object.assign(new Error('identity_missing_subject'), { status: 502 });
  const raw: Record<string, unknown> = { ...session, user };
  return {
    userId: userId || `user-${email.toLowerCase()}`,
    email: email.toLowerCase(),
    displayName: stringValue(user.display_name || user.displayName || user.full_name) || email || userId,
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(Number(session.expiresIn ?? session.expires_in))
      ? { expiresIn: Number(session.expiresIn ?? session.expires_in) }
      : {}),
    scopes: scopesOf(session).concat(scopesOf(user)),
    raw,
  };
}

/**
 * Roles the fallback environment variable may grant. `admin` is deliberately
 * excluded: admin is only ever granted by the server-side bootstrap allow-list.
 */
const FALLBACK_ROLES: readonly AuthUserRole[] = ['responder', 'volunteer', 'citizen', 'operator', 'manager'];

function fallbackRole(): AuthUserRole {
  const configured = (process.env.SOS_AUTH_DEFAULT_ROLE || 'responder').trim().toLowerCase();
  return (FALLBACK_ROLES as readonly string[]).includes(configured)
    ? (configured as AuthUserRole)
    : 'responder';
}

/**
 * Map a verified identity to an SOS role.
 *
 * Order:
 *  1. server-side bootstrap admin allow-list (email match, lower-cased);
 *  2. `SOS_AUTH_DEFAULT_ROLE` (default `responder`; never `admin`).
 *
 * The client never supplies any of these values, and neither the request body
 * nor an unverified token claim is consulted.
 */
export function roleForIdentity(identity: Pick<VerifiedIdentity, 'userId' | 'email'>): AuthUserRole {
  const email = String(identity.email || '').trim().toLowerCase();
  if (email && bootstrapAdmins().has(email)) return 'admin';
  return fallbackRole();
}

export interface IdentityRole {
  role: AuthUserRole;
  /** Why this role was chosen; useful for honest `/me` and audit output. */
  source: 'bootstrap-admin' | 'default-role';
}

export function roleForIdentityWithSource(identity: Pick<VerifiedIdentity, 'userId' | 'email'>): IdentityRole {
  const role = roleForIdentity(identity);
  return { role, source: role === 'admin' ? 'bootstrap-admin' : 'default-role' };
}

/**
 * Map a Tier-2 error to an SOS auth response without leaking upstream bodies.
 */
export function authErrorStatus(error: unknown): { status: number; code: string; detail: string } {
  if (error instanceof CapabilitiesError) {
    if (error.status === 401) return { status: 401, code: 'invalid_credentials', detail: 'Email or password is incorrect.' };
    if (error.status === 400 || error.status === 422) return { status: 400, code: 'invalid_request', detail: 'The identity provider rejected the request.' };
    if (error.status === 403) return { status: 403, code: 'auth_rejected', detail: 'The identity provider rejected this identity operation.' };
    if (error.status === 429) return { status: 429, code: 'rate_limited', detail: 'Too many authentication attempts.' };
    if (error.status === 409) return { status: 409, code: 'identity_conflict', detail: 'The identity already exists.' };
    if (error.status === 503 || error.status === 502) {
      return { status: 503, code: 'identity_not_configured', detail: 'The Tier-2 identity capability is unavailable.' };
    }
    if (error.status === 404) {
      return { status: 503, code: 'identity_not_configured', detail: 'The Tier-2 identity capability is not published on this deployment.' };
    }
  }
  return { status: 503, code: 'identity_not_configured', detail: 'Identity verification is unavailable.' };
}

export interface Tier2Session {
  identity: VerifiedIdentity;
  /** Token SOS keeps inside its signed session and forwards to Tier-2. */
  token?: string;
  refreshToken?: string;
  exchanged: boolean;
}

/**
 * Fill in a missing email/subject by asking the Tier-2 `auth.me` capability
 * with the freshly minted user token. A failure is not fatal: the login itself
 * already succeeded.
 */
async function enrichIdentity(
  client: CapabilitiesClient,
  identity: VerifiedIdentity,
  token: string | undefined,
  correlationId?: string,
): Promise<VerifiedIdentity> {
  if (!token || (identity.email && identity.userId)) return identity;
  try {
    const me = await client.auth.me({ token, ...(correlationId ? { correlationId } : {}) }) as unknown as Record<string, unknown>;
    const profile = (me.user && typeof me.user === 'object' ? me.user : me) as Record<string, unknown>;
    const merged = identityFromSession({ ...me, user: profile, accessToken: token, refreshToken: identity.refreshToken });
    return {
      ...identity,
      userId: merged.userId || identity.userId,
      email: merged.email || identity.email,
      displayName: identity.displayName || merged.displayName,
    };
  } catch (error) {
    console.warn('[synapsecity-sos] auth_me_lookup_failed', (error as Error).message);
    return identity;
  }
}

/**
 * Verify credentials through Tier-2 and (optionally) exchange the user session
 * for a product-audience delegated token. The exchange is skipped gracefully
 * when the deployment's service credential may not mint tokens; `login` already
 * returned a user-scoped token, which is sufficient for Tier-2 calls.
 */
export async function tier2Login(
  client: CapabilitiesClient,
  input: { email: string; password: string; orgSlug?: string; correlationId?: string },
): Promise<Tier2Session> {
  const session = await client.auth.login({
    email: input.email,
    password: input.password,
    ...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
  }) as unknown as Record<string, unknown>;
  let identity = identityFromSession(session);
  identity = await enrichIdentity(client, identity, identity.accessToken, input.correlationId);
  let token = identity.accessToken;
  let exchanged = false;
  if (exchangeEnabled() && identity.userId) {
    try {
      const delegated = await client.auth.exchange({
        userId: identity.userId,
        audience: 'synapsecity-sos',
        scopes: exchangeScopes(),
        ttlSeconds: identity.expiresIn && identity.expiresIn >= 60 ? Math.min(identity.expiresIn, 3600) : undefined,
      });
      if (delegated?.accessToken) {
        token = delegated.accessToken;
        exchanged = true;
      }
    } catch (error) {
      const status = error instanceof CapabilitiesError ? error.status : 0;
      if (status !== 403) throw error;
      // exchange_forbidden/insufficient_scope: the user-scoped login token is
      // already correct; do not fail the login or widen the token.
      console.warn('[synapsecity-sos] auth_exchange_skipped', (error as Error).message);
    }
  }
  return {
    identity,
    ...(token ? { token } : {}),
    ...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
    exchanged,
  };
}

export async function tier2Register(
  client: CapabilitiesClient,
  input: { email: string; password: string; displayName?: string; orgSlug?: string },
): Promise<Tier2Session> {
  const session = await client.auth.register({
    email: input.email,
    password: input.password,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
  }) as unknown as Record<string, unknown>;
  const identity = identityFromSession(session);
  return {
    identity,
    ...(identity.accessToken ? { token: identity.accessToken } : {}),
    ...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
    exchanged: false,
  };
}

/** Rotate the delegated Tier-2 credential; the SOS session is reissued by auth. */
export async function tier2Refresh(
  client: CapabilitiesClient,
  refreshToken: string,
): Promise<{ accessToken?: string; refreshToken?: string; expiresIn?: number }> {
  const rotated = await client.auth.refresh(refreshToken) as unknown as Record<string, unknown>;
  const accessToken = stringValue(rotated.accessToken || rotated.access_token);
  const nextRefresh = stringValue(rotated.refreshToken || rotated.refresh_token);
  const expiresIn = Number(rotated.expiresIn ?? rotated.expires_in);
  return {
    ...(accessToken ? { accessToken } : {}),
    ...(nextRefresh ? { refreshToken: nextRefresh } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
  };
}

/** Best-effort upstream logout; a stateless SOS session is cleared by the console. */
export async function tier2Logout(client: CapabilitiesClient, refreshToken: string): Promise<void> {
  try {
    await client.auth.logout(refreshToken);
  } catch (error) {
    console.warn('[synapsecity-sos] auth_logout_upstream_failed', (error as Error).message);
  }
}

/** Password changes are owned by Tier-1 IAM and driven through Tier-2. */
export async function tier2ChangePassword(
  client: CapabilitiesClient,
  currentPassword: string,
  newPassword: string,
  options: RequestOptions = {},
): Promise<void> {
  await client.auth.changePassword(currentPassword, newPassword, options);
}

/**
 * Per-request capability client used when the service does not inject one.
 * The service always injects its own client so the public-URL guard applies.
 */
export function identityClient(): CapabilitiesClient {
  const baseUrl = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
  const timeoutMs = Math.min(Math.max(Number(process.env.SYNAPSEDX_TIMEOUT_MS) || 20_000, 1_000), 120_000);
  return new CapabilitiesClient({
    baseUrl,
    apiKey: process.env.SYNAPSEDX_API_KEY || undefined,
    timeoutMs,
    retries: 1,
  });
}

export function identityDependency(): string {
  return IDENTITY_DEPENDENCY;
}
