// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesClient, CapabilitiesError } from '@synapsedx/capabilities';
import { aiChat, aiStatus, jsonObjectFrom, aiUnavailable } from './ai';
import {
  assertAuthConfiguration,
  installAuthRoutes,
  requirePermission,
  requireSession,
  sessionFromRequest,
  type SessionClaims,
} from './auth';
import { bootstrapAdmins, configuredAuthMode, demoAuthAllowed } from './identity';
import { normalizeDispatchAssignment, assignmentResourceUnitId, requestedResourceUnitId } from './dispatch';
import { computeAfterAction, slaBreachCount } from './after-action';
import {
  EOP_PROMPT_VERSION,
  buildEopDraft,
  buildEopPrompt,
  draftFromAiPayload,
  orderIdFor,
  planOrderSeeds,
  renderEopMarkdown,
  type DraftContext,
  type EopDraft,
} from './eop';
import { HttpError, badGateway, badRequest, conflict, notFoundError, serviceUnavailable } from './errors';
import {
  filterRows,
  MAX_SCAN_RECORDS,
  pageAll,
  parseNumber,
  parseBoolean,
  recordTimestamp,
  type Data,
  type PageLike,
} from './filters';
import {
  hazardDistanceMeters,
  hazardPoints,
  inPolygonHazards,
  nearHazards,
  parseNearQuery,
  validatePolygon,
} from './geo';
import { hazardTtlHours, isHazardStale, sseErrorFrame, sseHazardsFrame, sseHeartbeatFrame } from './hazards';
import { incrementCounter, metricsMiddleware, recordDependency, renderMetrics } from './metrics';
import { planOptimization } from './optimizer';
import { HitlError, assertApproved, buildHandoff, createApproval, decideApproval, hitlRequired, listPendingApprovals } from './hitl';
import { publicMutualAidProjection, validateAccept, validateRequest, type MutualAidAccept, type MutualAidRequest } from './mutual-aid';
import { fromNgsiLdList } from './projection';
import { rateLimiters } from './rate-limit';
import {
  assertPublishable,
  revisionFromDelta,
  validateSitrepCreate,
  validateSitrepUpdate,
} from './sitrep';
import {
  connectorNotConfigured,
  connectorStatusFromRuns,
  connectorUnavailable,
  ingestStatusFromRun,
  isVndmsConnectorJob,
  isVndmsRecord,
  normalizeIngestBatch,
  toVndmsHazard,
  type IngestConnectorStatus,
} from './vndms';
import { proxyVietMapTile, vietMapAutocomplete, vietMapConfigured, vietMapGeocode, vietMapPlace, vietMapReverse, vietMapTileStyle } from './vietmap';

const app = express();
const PORT = Number(process.env.PORT || 8084);
const TIER2_URL = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
const SERVICE_KEY = process.env.SYNAPSEDX_API_KEY;
const TIER2_TIMEOUT_MS = Math.min(Math.max(Number(process.env.SYNAPSEDX_TIMEOUT_MS) || 20_000, 1_000), 120_000);
const STREAM_EVENT_POLL_MS = Math.min(Math.max(Number(process.env.SOS_STREAM_EVENT_POLL_MS) || 2_000, 500), 30_000);

function assertPublic(url: string): string {
  const parsed = new URL(url);
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
  if ((local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') || (!local && parsed.protocol !== 'https:')) {
    throw new Error('SYNAPSEDX_BASE_URL must be a public HTTPS endpoint');
  }
  return url.replace(/\/$/, '');
}

const PUBLIC_TIER2_URL = assertPublic(TIER2_URL);

type Spec = { id: string; name: string; entityType: string; description: string; public?: boolean };
type Row = { id: string; data: Data; version?: number; createdAt?: string; updatedAt?: string };

const DATASETS = {
  events: { id: 'sos-emergency-events', name: 'SynapseCitySOS emergency events', entityType: 'EmergencyEvent', description: 'Emergency event command records', public: true },
  eop: { id: 'sos-eop-plans', name: 'SynapseCitySOS EOP plans', entityType: 'EmergencyOperationsPlan', description: 'Emergency operations plans' },
  dispatch: { id: 'sos-dispatch-orders', name: 'SynapseCitySOS dispatch orders', entityType: 'DispatchOrder', description: 'Emergency dispatch orders' },
  resources: { id: 'sos-resource-units', name: 'SynapseCitySOS resource units', entityType: 'ResourceUnit', description: 'Emergency response resources' },
  sitrep: { id: 'sos-sitreps', name: 'SynapseCitySOS situation reports', entityType: 'SituationReport', description: 'Emergency situation reports' },
  hazards: { id: 'sos-hazard-layers', name: 'SynapseCitySOS hazard layers', entityType: 'HazardLayer', description: 'Flood, storm and other hazard observations', public: true },
  afterAction: { id: 'sos-after-action-reports', name: 'SynapseCitySOS after action reports', entityType: 'AfterActionReport', description: 'Emergency after action reports' },
  hazardRuns: { id: 'sos-hazard-ingest-runs', name: 'SynapseCitySOS hazard ingest runs', entityType: 'HazardIngestRun', description: 'VNDMS ingest run history' },
  mutualAid: { id: 'sos-mutual-aid-requests', name: 'SynapseCitySOS mutual aid requests', entityType: 'MutualAidRequest', description: 'Cross-agency resource requests, accepts and handoffs' },
} as Record<string, Spec>;

// Product-boundary invariant: SOS may only ever touch sos-* datasets. A city-*
// dataset belongs to the separate SynapseCity product and must never be read
// or written from this service.
for (const spec of Object.values(DATASETS)) {
  if (!spec.id.startsWith('sos-')) throw new Error(`SynapseCitySOS dataset must use the sos- prefix: ${spec.id}`);
}

const PUBLIC_URL = 'https://sos.synapsecity.sbs';
const TERMINAL_EVENT_STATUSES = new Set(['resolved', 'canceled', 'archived']);

const SOS_METADATA = {
  product: 'synapsecity-sos',
  domain: 'emergency-operations',
  publicUrl: PUBLIC_URL,
  features: [
    'hazards',
    'mutual aid',
    'emergency events',
    'public emergency projection',
    'EOP',
    'dispatch',
    'resource units',
    'SITREP',
    'AAR',
    'live hazard stream',
    'command centre',
    'phase boards',
    'rescue operations',
    'public hazard map',
    'map',
    'geocoding',
    'ai',
    'auth-shell',
  ],
  notOwned: [
    'city assets',
    'city incidents',
    'city users',
    'IoT',
    'maintenance',
    'preventive maintenance',
    'technician portal',
    'infrastructure alerts',
    'notifications',
    'budgets',
    'operational reports',
    'geofences',
    'ingest',
    'public asset map',
    'public incident reporting',
    'public incident lookup',
  ],
  datasets: Object.values(DATASETS).map((spec) => spec.id),
  dependency: {
    product: 'synapsedx',
    tier: 2,
    publicUrl: PUBLIC_TIER2_URL,
    sdk: '@synapsedx/capabilities',
  },
  auth: {
    shell: 'hmac-session',
    mode: configuredAuthMode(),
    demoEnabled: demoAuthAllowed(),
    identityProvider: 'tier-2-auth-capability -> tier-1-iam',
    bootstrapAdminsConfigured: bootstrapAdmins().size > 0,
  },
  limitations: {
    sdk: '@synapsedx/capabilities@^0.3.0 from the public npm registry',
    events: 'hazard SSE consumes the Tier-2 event feed with Last-Event-ID resume and falls back to snapshot polling only when the feed is unavailable',
    ai: 'EOP drafts use the Tier-2 AI capability; an unavailable AI returns a typed 503 unless the caller opts into the labelled deterministic fallback',
    scheduled_ingest: 'VNDMS ingestion is scheduled by the Tier-2 jobs API; SOS validates pushes and reports connector run history, it never runs a local poller',
    spatial: 'in-memory geo predicate until Tier-2 exposes a spatial query',
  },
};

// City-infrastructure namespaces belong to SynapseCity (https://synapsecity.sbs).
// Reject them here, before any emergency route or Tier-2 call.
const FOREIGN_V1_NAMESPACES: readonly string[] = [
  'assets',
  'incidents',
  'maintenance',
  'iot',
  'alerts',
  'budgets',
  'reports',
  'notifications',
  'users',
  'geofences',
  'ingest',
  'city',
];
const FOREIGN_V1_PUBLIC_NAMESPACES: readonly string[] = ['assets', 'incidents'];

function decodedPath(value: string): string | null {
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return current;
      current = decoded;
    } catch { return null; }
  }
  return current;
}

function normalizedPath(raw: string): string {
  const withoutQuery = (raw.split('?')[0] || '/').split('#')[0];
  const decoded = decodedPath(withoutQuery);
  if (decoded === null) return '/__invalid_path__';
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment.toLowerCase());
  }
  return `/${segments.join('/')}`;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isForeignNamespace(raw: string): boolean {
  const path = normalizedPath(raw);
  return FOREIGN_V1_NAMESPACES.some((namespace) => within(path, `/v1/${namespace}`))
    || FOREIGN_V1_PUBLIC_NAMESPACES.some((namespace) => within(path, `/v1/public/${namespace}`));
}

// Public projections and provider reads are the only unauthenticated SOS API
// surfaces. Everything else under /v1/emergency and /v1/hazards needs a shell
// session. The hazard stream is a public projection and needs no credential.
function isPublicSosPath(path: string): boolean {
  return path === '/v1/sos'
    || within(path, '/v1/geo')
    || within(path, '/v1/map')
    || within(path, '/v1/ai')
    || path === '/v1/emergency/public'
    || path.startsWith('/v1/emergency/public/')
    || path === '/v1/emergency/stream/hazards'
    || path === '/v1/emergency/resources/shelters/near'
    || path === '/v1/hazards/recent'
    || path.startsWith('/v1/hazards/recent/')
    || path === '/v1/hazards/vndms-live'
    || path === '/v1/hazards/ingest/status'
    || within(path, '/v1/hazards/geo');
}

function requiresSession(path: string, method: string): boolean {
  const verb = method.toUpperCase();
  if (within(path, '/v1/emergency')) return !isPublicSosPath(path);
  if (within(path, '/v1/hazards')) {
    if (isPublicSosPath(path)) return false;
    return verb !== 'GET' && verb !== 'HEAD';
  }
  return false;
}

/**
 * Authorization matrix. Returns the permission required for a protected route
 * or `null` for a public/read route. Every mutation has an explicit entry; a
 * new mutation that forgets one falls back to `emergency:admin` (deny).
 */
export function requiredPermissionFor(path: string, method: string): string | null {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return 'emergency:read';
  if (within(path, '/v1/hazards')) return 'emergency:dispatch';
  if (within(path, '/v1/emergency/eop')) {
    if (path.endsWith('/approve') || path.endsWith('/publish') || path.endsWith('/submit')) return 'emergency:eop';
    return 'emergency:write';
  }
  if (within(path, '/v1/emergency/dispatch')) return 'emergency:dispatch';
  if (within(path, '/v1/emergency/resources')) return 'emergency:dispatch';
  if (within(path, '/v1/emergency/sitrep')) {
    return path.endsWith('/publish') ? 'emergency:dispatch' : 'emergency:write';
  }
  if (within(path, '/v1/emergency/after-action')) {
    return path.endsWith('/publish') ? 'emergency:eop' : 'emergency:write';
  }
  if (path.endsWith('/resolve')) return 'emergency:dispatch';
  if (within(path, '/v1/emergency')) return 'emergency:write';
  return 'emergency:admin';
}

function client(req: Request): CapabilitiesClient {
  const factory = app.locals.createClient as ((request: Request) => CapabilitiesClient) | undefined;
  if (factory) return factory(req);
  // Only the user-scoped Tier-2 credential verified at login is forwarded
  // upstream. The SOS session token itself (and any arbitrary client-supplied
  // bearer value) must never reach Tier-2.
  const token = sessionFromRequest(req)?.tier2_token || process.env.SYNAPSEDX_TOKEN;
  return new CapabilitiesClient({
    baseUrl: PUBLIC_TIER2_URL,
    token: token || undefined,
    apiKey: req.header('x-api-key') || SERVICE_KEY,
    timeoutMs: TIER2_TIMEOUT_MS,
    retries: 1,
  });
}

function now(): string { return new Date().toISOString(); }

/** Conditional-write precondition: `If-Match: "3"` or body `if_version`/`ifVersion`. */
export function requestedVersion(req: Request): number | undefined {
  const header = req.header('if-match');
  let fromHeader: number | undefined;
  if (header) {
    const match = header.trim().match(/^(?:W\/)?"?(\d+)"?$/);
    if (match) fromHeader = Number(match[1]);
    else if (header.trim() !== '*') throw badRequest('invalid_if_match', 'If-Match must be a numeric record version');
  }
  const raw = req.body && typeof req.body === 'object' ? (req.body as Data).if_version ?? (req.body as Data).ifVersion : undefined;
  let fromBody: number | undefined;
  if (raw !== undefined && raw !== null && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw badRequest('invalid_if_version', 'if_version must be a non-negative integer');
    fromBody = parsed;
  }
  if (fromHeader !== undefined && fromBody !== undefined && fromHeader !== fromBody) {
    throw badRequest('version_precondition_mismatch', 'If-Match and if_version disagree');
  }
  return fromHeader ?? fromBody;
}

/** Send a record with its Tier-2 record version as an ETag. */
function sendRecord(res: Response, data: Data, status = 200): void {
  const version = Number(data.record_version);
  if (Number.isFinite(version)) {
    res.setHeader('etag', `"${version}"`);
    res.setHeader('x-record-version', String(version));
  }
  res.status(status).json(data);
}

function asData(row: Row): Data {
  return {
    ...row.data,
    id: row.data.id || row.id,
    created_at: row.data.created_at || row.createdAt,
    updated_at: row.data.updated_at || row.updatedAt,
    ...(Number.isFinite(row.version) ? { record_version: row.version } : {}),
  };
}

function limitOf(req: Request, fallback = 100): number {
  const n = Number(req.query.limit);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 500) : fallback;
}

function offsetOf(req: Request): number {
  const n = Number(req.query.skip ?? req.query.offset);
  return Number.isFinite(n) ? Math.max(Math.floor(n), 0) : 0;
}

function body(req: Request): Data {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw badRequest('request_body_must_be_an_object');
  return req.body as Data;
}

function notFound(error: unknown): boolean {
  return error instanceof CapabilitiesError && error.status === 404;
}

async function dataset(c: CapabilitiesClient, spec: Spec) {
  try { return await c.datasets.get(spec.id); }
  catch (error) {
    if (!notFound(error)) throw error;
    try {
      const created = await c.datasets.create({
        slug: spec.id,
        name: spec.name,
        entityType: spec.entityType,
        description: spec.description,
        license: 'CC-BY-4.0',
        schemaVersion: '1.0.0',
        public: spec.public === true,
      });
      return spec.public ? c.datasets.publish(created.id) : created;
    } catch (createError) {
      if (createError instanceof CapabilitiesError && (createError.status === 400 || createError.status === 409)) return c.datasets.get(spec.id);
      throw createError;
    }
  }
}

async function listPage(c: CapabilitiesClient, spec: Spec, req: Request, fallbackLimit = 100): Promise<Data[]> {
  const ds = await dataset(c, spec);
  const page = await c.records.list(ds.id, { limit: limitOf(req, fallbackLimit), offset: offsetOf(req) });
  return page.items.map(asData);
}

async function listAllRows(c: CapabilitiesClient, spec: Spec, maxRecords = MAX_SCAN_RECORDS) {
  const ds = await dataset(c, spec);
  const page = await pageAll<Data>(
    ({ limit, offset }) => c.records.list<Data>(ds.id, { limit, offset }) as Promise<PageLike<Data>>,
    { maxRecords },
  );
  return page;
}

async function get(c: CapabilitiesClient, spec: Spec, id: string): Promise<Data> {
  const ds = await dataset(c, spec);
  const row = await c.records.get(ds.id, id);
  return asData(row as Row);
}

// Per-record serialization prevents two in-flight read-modify-write operations
// in this process from losing an update. Cross-process conflicts still require
// the Tier-2 conditional-update capability (SynapseDX #27); callers can pass
// `if_version` to get a deterministic 409 today.
const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, previous.then(() => current));
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function write(c: CapabilitiesClient, spec: Spec, input: Data, id = String(input.id || randomUUID())): Promise<Data> {
  return withLock(`${spec.id}:${id}`, async () => {
    const ds = await dataset(c, spec);
    const timestamp = now();
    const data = { ...storedPayload(input), id, created_at: input.created_at || timestamp, updated_at: timestamp };
    try {
      const created = await c.records.create(ds.id, data, { id, publish: spec.public === true });
      return asData(created as Row);
    } catch (error) {
      // Only a uniqueness conflict (409) means "the record already exists"; a
      // 400 is a validation failure and must never be retried as an update
      // (issue #20). The retry is conditional on the version read here, so a
      // concurrent writer still surfaces as a 409 instead of being overwritten.
      if (error instanceof CapabilitiesError && error.status === 409) {
        const current = await get(c, spec, id);
        const expected = Number(current.record_version);
        try {
          const updated = await c.records.update(
            ds.id,
            id,
            { ...data, created_at: current.created_at ?? data.created_at },
            Number.isFinite(expected) ? { ifVersion: expected } : {},
          );
          return asData(updated as Row);
        } catch (retryError) {
          if (retryError instanceof CapabilitiesError && retryError.status === 409) {
            throw conflict('record_version_conflict', `record ${id} changed while it was being created`);
          }
          throw retryError;
        }
      }
      throw error;
    }
  });
}

async function update(
  c: CapabilitiesClient,
  spec: Spec,
  id: string,
  patch: Data,
  options: { ifVersion?: number; retryOnConflict?: boolean } = {},
): Promise<Data> {
  const apply = async (): Promise<Data> => {
    const current = await get(c, spec, id);
    const currentVersion = Number(current.record_version);
    if (options.ifVersion !== undefined && Number.isFinite(currentVersion) && options.ifVersion !== currentVersion) {
      throw conflict('record_version_conflict', `expected version ${options.ifVersion}, found ${currentVersion}`, { current_version: currentVersion });
    }
    const ds = await dataset(c, spec);
    // Always send the version we read as `If-Match`: two concurrent writers can
    // no longer silently lose one update (Tier-2 issue #27).
    const expected = options.ifVersion ?? (Number.isFinite(currentVersion) ? currentVersion : undefined);
    const merged: Data = { ...current, ...storedPayload(patch), id, updated_at: now() };
    delete merged.record_version;
    try {
      const updated = await c.records.update(
        ds.id,
        id,
        merged,
        expected !== undefined ? { ifVersion: expected } : {},
      );
      return asData(updated as Row);
    } catch (error) {
      if (error instanceof CapabilitiesError && error.status === 409) {
        incrementCounter('tier2_conflicts', { dataset: spec.id });
        throw conflict('record_version_conflict', `record ${id} was modified by another request`, { current_version: currentVersion });
      }
      throw error;
    }
  };
  return withLock(`${spec.id}:${id}`, async () => {
    if (!options.retryOnConflict) return apply();
    try {
      return await apply();
    } catch (error) {
      if (error instanceof HttpError && error.code === 'record_version_conflict') return apply();
      throw error;
    }
  });
}

/** Public projections read the Tier-2 publication API (NGSI-LD entities). */
async function listAllPublic(c: CapabilitiesClient, spec: Spec, maxRecords = MAX_SCAN_RECORDS): Promise<{ items: Data[]; truncated: boolean }> {
  const ds = await dataset(c, spec);
  if (spec.public && ds.status !== 'published') {
    try { await c.datasets.publish(ds.id); } catch { /* keep the existing publication state */ }
  }
  const max = Math.max(1, maxRecords);
  const pageSize = 500;
  const items: Data[] = [];
  let offset = 0;
  let truncated = false;
  while (items.length < max) {
    const page = await c.datasets.entities(ds.id, { limit: Math.min(pageSize, max - items.length), offset });
    const batch = Array.isArray(page) ? fromNgsiLdList(page) : [];
    items.push(...batch);
    offset += batch.length;
    if (batch.length < pageSize) break;
    if (items.length >= max) truncated = true;
  }
  return { items: items.slice(0, max), truncated };
}

async function dependencyHealth(c: CapabilitiesClient) {
  const started = Date.now();
  const checkedAt = now();
  try {
    await c.health();
    const datasetChecks = await Promise.all(Object.values(DATASETS).map(async (spec) => {
      try {
        const ds = await c.datasets.get(spec.id);
        return { id: spec.id, reachable: true, status: ds.status, public: spec.public === true, checked_at: checkedAt };
      } catch (error) {
        if (notFound(error)) return { id: spec.id, reachable: true, status: 'missing', public: spec.public === true, checked_at: checkedAt };
        return { id: spec.id, reachable: false, status: 'error', public: spec.public === true, checked_at: checkedAt };
      }
    }));
    const degraded = datasetChecks.some((check) => !check.reachable);
    recordDependency('synapsedx', !degraded, Date.now() - started, degraded ? 'one or more datasets unreachable' : undefined);
    return {
      name: 'synapsedx',
      reachable: true,
      status: degraded ? 'degraded' : 'ok',
      checked_at: checkedAt,
      latency_ms: Date.now() - started,
      datasets: datasetChecks,
    };
  } catch (error) {
    recordDependency('synapsedx', false, Date.now() - started, (error as Error).message);
    return {
      name: 'synapsedx',
      reachable: false,
      status: 'unreachable',
      checked_at: checkedAt,
      latency_ms: Date.now() - started,
      detail: 'Tier-2 capabilities API did not respond',
      datasets: [],
    };
  }
}

/**
 * Read VNDMS connector state from the Tier-2 scheduled-jobs API. SOS does not
 * own a scheduler: it only projects the job definition and its run history.
 * An unavailable jobs API is reported precisely, never as "ready".
 */
async function vndmsConnectorStatus(c: CapabilitiesClient): Promise<IngestConnectorStatus> {
  const checkedAt = now();
  const jobs = (c as unknown as {
    jobs?: {
      list?: (query?: { limit?: number; offset?: number }) => Promise<{ items?: unknown[] }>;
      runs?: (id: string, query?: { limit?: number; offset?: number }) => Promise<{ items?: unknown[] }>;
    };
  }).jobs;
  if (!jobs || typeof jobs.list !== 'function' || typeof jobs.runs !== 'function') {
    return connectorUnavailable({ code: 'capability_unavailable' }, checkedAt);
  }
  const started = Date.now();
  try {
    const page = await jobs.list({ limit: 100 });
    const items = Array.isArray(page?.items) ? page.items as Data[] : [];
    const job = items.find((candidate) => candidate && typeof candidate === 'object' && isVndmsConnectorJob(candidate));
    if (!job) {
      recordDependency('synapsedx-jobs', true, Date.now() - started);
      return connectorNotConfigured(checkedAt);
    }
    let runs: Data[] = [];
    try {
      const runPage = await jobs.runs(String(job.id), { limit: 20 });
      runs = Array.isArray(runPage?.items) ? runPage.items as Data[] : [];
    } catch (error) {
      recordDependency('synapsedx-jobs', false, Date.now() - started, (error as Error).message);
      return { ...connectorStatusFromRuns(job, [], Date.now()), error: 'tier2_job_runs_unavailable' };
    }
    recordDependency('synapsedx-jobs', true, Date.now() - started);
    return connectorStatusFromRuns(job, runs);
  } catch (error) {
    recordDependency('synapsedx-jobs', false, Date.now() - started, (error as Error).message);
    incrementCounter('tier2_jobs_lookup', { result: 'error' });
    return connectorUnavailable(error, checkedAt);
  }
}

async function latestIngestRun(c: CapabilitiesClient): Promise<Data | null> {
  const { items } = await listAllRows(c, DATASETS.hazardRuns).catch(() => ({ items: [] as Data[], truncated: false }));
  return [...items]
    .sort((a, b) => (Date.parse(String(b.finished_at ?? b.created_at ?? '')) || 0) - (Date.parse(String(a.finished_at ?? a.created_at ?? '')) || 0))[0] ?? null;
}

function publicEvent(event: Data): Data {
  return {
    id: event.id,
    title: event.title,
    event_type: event.event_type,
    severity: event.severity,
    status: event.status,
    location: event.location,
    geometry: event.geometry,
    started_at: event.started_at,
    created_at: event.created_at,
    updated_at: event.updated_at,
  };
}

function actorOf(res: Response): { username?: string; id?: string } {
  const session = res.locals.session as SessionClaims | undefined;
  return { username: session?.username, id: session?.sub };
}

function sessionOf(res: Response): SessionClaims | undefined {
  return res.locals.session as SessionClaims | undefined;
}

/** Validate an inbound precondition against the record we just read. */
function precondition(req: Request, current: Data): number | undefined {
  const expected = requestedVersion(req);
  const version = Number(current.record_version);
  if (expected !== undefined && Number.isFinite(version) && expected !== version) {
    throw conflict('record_version_conflict', `expected version ${expected}, found ${version}`, { current_version: version });
  }
  return expected;
}

/** Preconditions and injected wire fields are never persisted as data. */
function storedPayload(input: Data): Data {
  const data = { ...input };
  delete data.record_version;
  delete data.if_version;
  delete data.ifVersion;
  delete data.if_match;
  return data;
}

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || 'https://sos.synapsecity.sbs');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(metricsMiddleware);

app.get('/health', async (req, res, next) => {
  try {
    const dependency = await dependencyHealth(client(req));
    res.json({
      status: dependency.reachable ? (dependency.status === 'ok' ? 'ok' : 'degraded') : 'degraded',
      service: 'synapsecity-sos',
      tier: 3,
      checked_at: dependency.checked_at,
      dependencies: [dependency],
      tier2Url: PUBLIC_TIER2_URL,
    });
  } catch (error) { next(error); }
});
app.get('/ready', async (req, res, next) => {
  try {
    const dependency = await dependencyHealth(client(req));
    const ready = dependency.reachable && dependency.status === 'ok';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'degraded',
      service: 'synapsecity-sos',
      tier: 3,
      checked_at: dependency.checked_at,
      dependencies: [dependency],
      tier2Url: PUBLIC_TIER2_URL,
    });
  } catch (error) { next(error); }
});
app.get('/metrics', (_req, res) => {
  res.type('text/plain; version=0.0.4').send(renderMetrics());
});

app.get('/v1/sos', (_req, res) => res.json(SOS_METADATA));

app.use('/v1/auth', rateLimiters.auth.middleware);
installAuthRoutes(app, { clientForRequest: client });

app.use('/v1', (req, res, next) => {
  if (!isForeignNamespace(req.originalUrl)) return next();
  res.status(404).json({ error: 'not_found', product: 'synapsecity-sos' });
});

app.use('/v1', (req, res, next) => {
  const path = normalizedPath(req.originalUrl);
  if (path === '/v1/auth' || path.startsWith('/v1/auth/')) return next();
  if (!requiresSession(path, req.method)) return next();
  requireSession(req, res, () => {
    const permission = requiredPermissionFor(path, req.method);
    if (!res.locals.session) {
      res.status(401).json({ detail: 'unauthorized', error: 'unauthorized' });
      return;
    }
    if (!permission) return next();
    requirePermission(permission)(req, res, next);
  });
});

app.use('/v1/emergency/stream', rateLimiters.stream.middleware);
app.use('/v1/geo', rateLimiters.geo.middleware);
app.use('/v1/ai', rateLimiters.ai.middleware);

// ── Emergency events and public projection ───────────────────────────────────

app.get('/v1/emergency/public/status', async (req, res, next) => {
  try {
    const dependency = await dependencyHealth(client(req));
    const [runs, latestRun, connector] = await Promise.all([
      listAllPublic(client(req), DATASETS.hazards).catch(() => ({ items: [], truncated: false })),
      latestIngestRun(client(req)),
      vndmsConnectorStatus(client(req)),
    ]);
    const ingest = ingestStatusFromRun(latestRun, Date.now(), connector);
    res.setHeader('cache-control', 'public, max-age=30');
    res.json({
      status: dependency.reachable && dependency.status === 'ok' ? 'ok' : 'degraded',
      data_available: dependency.reachable,
      checked_at: dependency.checked_at,
      hazard_feed: { ...ingest, records_visible: runs.items.length },
    });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/public', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllPublic(client(req), DATASETS.events);
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
    const events = items.filter((event) => !TERMINAL_EVENT_STATUSES.has(String(event.status ?? '')))
      .filter((event) => (statusFilter ? String(event.status) === statusFilter : true));
    const limit = limitOf(req, 500);
    const offset = offsetOf(req);
    res.setHeader('cache-control', 'public, max-age=30');
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(events.slice(offset, offset + limit).map(publicEvent));
  } catch (error) { next(error); }
});

app.get('/v1/emergency/health', async (req, res, next) => {
  try {
    const dependency = await dependencyHealth(client(req));
    res.json({ service: 'synapsecity-sos', checked_at: dependency.checked_at, dependencies: [dependency] });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/sosconn/status', async (req, res, next) => {
  try {
    const [dependency, ai] = await Promise.all([
      dependencyHealth(client(req)),
      aiStatus(client(req), PUBLIC_TIER2_URL),
    ]);
    res.setHeader('cache-control', 'no-store');
    res.json({
      provider: ai.provider,
      configured: ai.configured,
      reachable: dependency.reachable,
      model: ai.model,
      status: !dependency.reachable
        ? 'dependency_unreachable'
        : ai.status === 'ok'
          ? 'ready'
          : ai.status === 'degraded'
            ? 'degraded'
            : 'capability_unavailable',
      detail: ai.detail,
      checked_at: ai.checked_at,
      base_url: PUBLIC_TIER2_URL,
      dependency: { tier2_reachable: dependency.reachable, status: dependency.status },
    });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/sos/timeline', async (req, res, next) => {
  try {
    const { items } = await listAllRows(client(req), DATASETS.events);
    const dispatch = await listAllRows(client(req), DATASETS.dispatch).catch(() => ({ items: [], truncated: false }));
    const firstAssignment = new Map<string, number>();
    for (const order of dispatch.items) {
      const eventId = String(order.emergency_event_id ?? '');
      if (!eventId) continue;
      const assignments = Array.isArray(order.assignments) ? order.assignments : [];
      const times = assignments
        .map((assignment) => (assignment && typeof assignment === 'object' ? Date.parse(String((assignment as Data).assigned_at ?? '')) : Number.NaN))
        .filter((value) => Number.isFinite(value));
      const direct = Date.parse(String(order.assigned_at ?? order.started_at ?? ''));
      if (Number.isFinite(direct)) times.push(direct);
      if (times.length === 0) continue;
      const earliest = Math.min(...times);
      const previous = firstAssignment.get(eventId);
      if (previous === undefined || earliest < previous) firstAssignment.set(eventId, earliest);
    }
    const limit = limitOf(req, 30);
    res.json(items.slice(0, limit).map((event) => ({
      event_id: event.id,
      event_code: event.event_code || null,
      title: event.title,
      severity: event.severity,
      status: event.status,
      created_at: event.created_at,
      source_ref: event.source || null,
      sla_breach_count: slaBreachCount(event, firstAssignment.get(String(event.id)) ?? null),
      sla_threshold_minutes: String(event.severity) === 'critical' ? 30 : String(event.severity) === 'high' ? 60 : String(event.severity) === 'medium' ? 120 : 240,
      last_update: event.updated_at || event.created_at,
    })));
  } catch (error) { next(error); }
});

app.get('/v1/emergency', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.events);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.post('/v1/emergency', async (req, res, next) => {
  try {
    const input = body(req);
    const event = await write(client(req), DATASETS.events, {
      ...input,
      source: input.source || 'manual',
      status: input.status || 'monitoring',
      started_at: input.started_at || now(),
      affected_asset_ids: input.affected_asset_ids || [],
      estimated_impact: input.estimated_impact || {},
      instructions: input.instructions || [],
      tags: input.tags || [],
      metadata: input.metadata || {},
      created_by: actorOf(res).username ?? null,
    });
    res.status(201).json(event);
  } catch (error) { next(error); }
});

// ── EOP ─────────────────────────────────────────────────────────────────────

async function loadEopInputs(c: CapabilitiesClient, event: Data) {
  const hazards = await listAllRows(c, DATASETS.hazards).catch(() => ({ items: [], truncated: false }));
  const resources = await listAllRows(c, DATASETS.resources).catch(() => ({ items: [], truncated: false }));
  const linkedHazards = hazards.items.filter((hazard) => String(hazard.linked_event_id ?? '') === String(event.id)
    || String(hazard.hazard_id ?? '') === String((event.metadata as Data | undefined)?.hazard_id ?? '\u0000'));
  return { hazards: linkedHazards, resources: resources.items };
}

async function findPlansForEvent(c: CapabilitiesClient, eventId: string): Promise<Data[]> {
  const { items } = await listAllRows(c, DATASETS.eop);
  return items
    .filter((plan) => String(plan.emergency_event_id ?? '') === eventId)
    .sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
}

interface EopGenerationOptions {
  title?: string;
  additionalContext?: string;
  allowDeterministicFallback?: boolean;
  correlationId?: string;
}

interface EopGenerationResult {
  draft: EopDraft;
  source: 'tier2-ai' | 'deterministic-fallback';
}

/**
 * Generate a draft through the Tier-2 AI capability. A deterministic draft is
 * only produced when the caller explicitly opts in; otherwise the typed 503
 * from `aiChat` propagates (issue #14). Provider/contract failures are the only
 * errors that can fall back — a bad request never silently becomes a template.
 */
async function generateEopDraft(
  c: CapabilitiesClient,
  context: DraftContext,
  version: number,
  options: EopGenerationOptions,
): Promise<EopGenerationResult> {
  try {
    // Do not spend a model call when Tier-2 reports that no model is
    // configured. A status probe failure is ignored so the chat call itself
    // produces the authoritative typed 503.
    const status = await aiStatus(c);
    if (!status.configured && status.reachable) throw aiUnavailable(status.detail);
    const completion = await aiChat(c, buildEopPrompt(context), { correlationId: options.correlationId });
    const payload = jsonObjectFrom(completion.content);
    if (!payload) throw badGateway('ai_draft_invalid', 'the AI completion was not a JSON object');
    const draft = draftFromAiPayload(context, version, payload, {
      model: completion.model,
      promptVersion: EOP_PROMPT_VERSION,
      generatedAt: context.generatedAt ?? now(),
      usage: completion.usage,
    });
    incrementCounter('eop_draft', { source: 'tier2-ai' });
    return { draft, source: 'tier2-ai' };
  } catch (error) {
    const upstreamFailure = error instanceof HttpError && (error.status === 502 || error.status === 503);
    if (!options.allowDeterministicFallback || !upstreamFailure) {
      incrementCounter('eop_draft', { source: 'unavailable' });
      throw error;
    }
    incrementCounter('eop_draft', { source: 'deterministic-fallback' });
    const draft = buildEopDraft(context, version);
    draft.metadata.ai_error = error instanceof Error ? error.message : String(error);
    draft.metadata.ai_error_code = error instanceof HttpError ? error.code : 'ai_capability_unavailable';
    draft.markdown_body = renderEopMarkdown(draft, context);
    return { draft, source: 'deterministic-fallback' };
  }
}

async function createEopVersion(
  c: CapabilitiesClient,
  event: Data,
  version: number,
  options: EopGenerationOptions = {},
): Promise<{ plan: Data; source: string }> {
  const { hazards, resources } = await loadEopInputs(c, event);
  const context: DraftContext = {
    event,
    hazards,
    resources,
    title: options.title,
    additionalContext: options.additionalContext,
    generatedAt: now(),
  };
  const id = `eop-${String(event.id)}-v${version}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180);
  const existing = await get(c, DATASETS.eop, id).catch((error) => { if (notFound(error)) return null; throw error; });
  if (existing) {
    return { plan: existing, source: String((existing.metadata as Data | undefined)?.generated_by ?? 'stored') };
  }
  const { draft, source } = await generateEopDraft(c, context, version, options);
  const plan = await write(c, DATASETS.eop, {
    ...draft,
    id,
    emergency_event_id: event.id,
    priority: (event.severity as string | undefined) ?? 'medium',
    created_by: null,
  }, id);
  return { plan, source };
}

app.post('/v1/emergency/eop/generate-draft', async (req, res, next) => {
  try {
    const c = client(req);
    const input = body(req);
    const eventId = String(input.emergency_event_id ?? '').trim();
    if (!eventId) throw badRequest('emergency_event_id_required');
    const event = await get(c, DATASETS.events, eventId).catch((error) => {
      if (notFound(error)) throw notFoundError('emergency_event_not_found', `no emergency event ${eventId}`);
      throw error;
    });
    const force = parseBoolean(input.force_new_version) === true;
    const allowFallback = input.fallback === 'deterministic' || parseBoolean(input.allow_deterministic_fallback) === true;
    const correlationId = res.getHeader('x-correlation-id')?.toString();
    // Serialise version selection per event so two concurrent requests cannot
    // both create "v1" (issue #14): exactly one draft per (event, version).
    const result = await withLock(`eop:event:${eventId}`, async () => {
      const plans = await findPlansForEvent(c, eventId);
      if (!force && plans.length > 0) {
        const latest = plans[plans.length - 1];
        return {
          plan: latest,
          source: String((latest.metadata as Data | undefined)?.generated_by ?? 'stored'),
          generated: false,
        };
      }
      const version = plans.length === 0 ? 1 : Math.max(...plans.map((plan) => Number(plan.version) || 0)) + 1;
      const created = await createEopVersion(c, event, version, {
        title: typeof input.title === 'string' ? input.title : undefined,
        additionalContext: typeof input.additional_context === 'string' ? input.additional_context : undefined,
        allowDeterministicFallback: allowFallback,
        correlationId,
      });
      return { ...created, generated: true };
    });
    const generatedBy = String((result.plan.metadata as Data | undefined)?.generated_by ?? result.source);
    const payload = {
      ...result.plan,
      generated_by: generatedBy,
      generated: result.generated,
      source: result.source,
      ...(generatedBy === 'deterministic-fallback' ? { warning: 'ai_unavailable_deterministic_fallback' } : {}),
    };
    if (!result.generated) {
      res.json({ ...payload, idempotent: true });
      return;
    }
    res.status(201).json(payload);
  } catch (error) { next(error); }
});

app.post('/v1/emergency/eop/:id/approve', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.eop, req.params.id);
    if (!['draft', 'review_pending', 'approved'].includes(String(current.status))) {
      throw conflict('invalid_eop_status', `cannot approve a plan in status ${current.status}`);
    }
    const ifVersion = precondition(req, current);
    if (String(current.status) === 'approved') {
      res.json({ ...current, idempotent: true });
      return;
    }
    const input = body(req);
    const actor = actorOf(res).username ?? 'sos-operator';
    const approvalId = String(input.approval_id || input.approvalId || '');
    let approval: any = null;
    if (hitlRequired() || approvalId) {
      if (!approvalId) throw new HitlError(428, 'approval_required', 'create an EOP approval first');
      approval = await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'eop.approve', actor });
    }
    sendRecord(res, await update(c, DATASETS.eop, req.params.id, {
      status: 'approved',
      review_notes: input.review_notes ?? current.review_notes ?? null,
      approved_by: actor,
      approved_at: now(),
      ...(approval ? { approval_id: approval.id, approved_role: approval.approverRoles[0] || null, approval_roles: approval.approverRoles } : {}),
    }, { ifVersion }));
  } catch (error) { next(error); }
});

app.post('/v1/emergency/eop/:id/publish', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.eop, req.params.id);
    if (!['approved', 'published'].includes(String(current.status))) {
      throw conflict('eop_not_approved', 'approve the EOP before publishing it');
    }
    const ifVersion = precondition(req, current);
    if (String(current.status) === 'published') {
      res.json({ ...current, idempotent: true });
      return;
    }
    sendRecord(res, await update(c, DATASETS.eop, req.params.id, {
      status: 'published',
      published_at: current.published_at || now(),
      published_by: actorOf(res).username ?? current.published_by ?? null,
    }, { ifVersion }));
  } catch (error) { next(error); }
});

app.patch('/v1/emergency/eop/:id/markdown', async (req, res, next) => {
  try {
    const input = body(req);
    if (input.markdown_body !== undefined && typeof input.markdown_body !== 'string') {
      throw badRequest('markdown_body_must_be_a_string');
    }
    const patch: Data = {
      markdown_body: input.markdown_body ?? null,
      review_notes: input.review_notes ?? null,
      updated_by: actorOf(res).username ?? null,
    };
    sendRecord(res, await update(client(req), DATASETS.eop, req.params.id, patch, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});

app.post('/v1/emergency/eop/:id/submit', async (req, res, next) => {
  try {
    const c = client(req);
    const plan = await get(c, DATASETS.eop, req.params.id);
    if (['archived'].includes(String(plan.status))) throw conflict('eop_archived', 'cannot submit an archived plan');
    const ifVersion = precondition(req, plan);
    const seeds = planOrderSeeds(plan);
    const created: Data[] = [];
    const existingIds: string[] = [];
    for (const seed of seeds) {
      const orderId = orderIdFor(String(plan.id), seed.action_id);
      const existing = await get(c, DATASETS.dispatch, orderId).catch((error) => {
        if (notFound(error)) return null;
        throw error;
      });
      if (existing) {
        existingIds.push(orderId);
        continue;
      }
      const order = await write(c, DATASETS.dispatch, {
        id: orderId,
        emergency_event_id: plan.emergency_event_id,
        eop_plan_id: plan.id,
        eop_plan_version: plan.version,
        task_title: seed.task_title,
        task_description: seed.task_description,
        priority: seed.priority,
        status: 'pending',
        required_capability: seed.required_capability,
        target_location: seed.target_location,
        target_district: (plan.metadata as Data | undefined)?.target_district ?? null,
        assignments: [],
        metadata: {
          action_id: seed.action_id,
          phase: seed.phase,
          estimated_minutes: seed.estimated_minutes,
          plan_version: plan.version,
          source: 'eop-submit',
        },
        created_by: actorOf(res).username ?? null,
      }, orderId);
      created.push(order);
    }
    const orderIds = [...existingIds, ...created.map((order) => String(order.id))];
    const submitted = await update(c, DATASETS.eop, String(plan.id), {
      status: 'approved',
      submitted_at: now(),
      submitted_by: actorOf(res).username ?? null,
      order_ids: orderIds,
    }, { ifVersion });
    const orders = orderIds.length > 0
      ? await Promise.all(orderIds.map((id) => get(c, DATASETS.dispatch, id)))
      : [];
    res.json({
      plan_id: submitted.id,
      task_source: 'synapsecity-sos',
      plan_status: submitted.status,
      created: created.length,
      existing: existingIds.length,
      idempotent: created.length === 0,
      orders,
    });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/eop', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.eop);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/eop/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.eop, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/emergency/eop', async (req, res, next) => {
  try {
    const input = body(req);
    if (!input.emergency_event_id) throw badRequest('emergency_event_id_required');
    const event = await get(client(req), DATASETS.events, String(input.emergency_event_id));
    const plans = await findPlansForEvent(client(req), String(event.id));
    const version = parseNumber(input.version, { min: 1 }) ?? (plans.length === 0 ? 1 : Math.max(...plans.map((plan) => Number(plan.version) || 0)) + 1);
    const id = String(input.id || `eop-${event.id}-v${version}`).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180);
    res.status(201).json(await write(client(req), DATASETS.eop, { ...input, id, emergency_event_id: event.id, version, status: 'draft', created_by: actorOf(res).username ?? null }, id));
  } catch (error) { next(error); }
});
app.put('/v1/emergency/eop/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.eop, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });

// ── Dispatch ────────────────────────────────────────────────────────────────

app.post('/v1/emergency/dispatch/optimize', async (req, res, next) => {
  try {
    const c = client(req);
    const orders = await listAllRows(c, DATASETS.dispatch);
    const resources = await listAllRows(c, DATASETS.resources);
    const plan = planOptimization(orders.items, resources.items);
    let autoAssigned = 0;
    let reestimated = 0;
    let staleFlagged = 0;
    for (const decision of plan.assignments) {
      const current = orders.items.find((order) => String(order.id) === decision.order_id);
      if (!current) continue;
      const assignments = Array.isArray(current.assignments) ? current.assignments : [];
      const assignedAt = now();
      await update(c, DATASETS.dispatch, decision.order_id, {
        status: 'assigned',
        assigned_resource_unit_id: decision.resource_unit_id,
        assigned_user_id: decision.resource_unit_id,
        assigned_at: assignedAt,
        eta_minutes: decision.eta_minutes,
        assignments: [
          ...assignments.filter((assignment) => {
            if (!assignment || typeof assignment !== 'object') return false;
            const item = assignment as Data;
            return String(item.assigned_resource_unit_id ?? item.resource_unit_id ?? '') !== decision.resource_unit_id;
          }),
          {
            resource_unit_id: decision.resource_unit_id,
            assigned_resource_unit_id: decision.resource_unit_id,
            assigned_user_id: decision.resource_unit_id,
            assigned_at: assignedAt,
            eta_minutes: decision.eta_minutes,
            assigned_by: 'sos-optimizer-v2',
          },
        ],
        metadata: { ...(current.metadata as Data || {}), optimizer: { algorithm: 'sos-capability-match-v2', distance_km: decision.distance_km, reason: decision.reason, optimized_at: now() } },
      }, { ifVersion: Number(current.record_version) || undefined });
      autoAssigned += 1;
      reestimated += 1;
    }
    for (const orderId of plan.stale) {
      const current = orders.items.find((order) => String(order.id) === orderId);
      if (!current) continue;
      const metadata = { ...(current.metadata as Data || {}), stale: true, stale_flagged_at: now() };
      await update(c, DATASETS.dispatch, orderId, { metadata }, { ifVersion: Number(current.record_version) || undefined });
      staleFlagged += 1;
    }
    res.json({
      optimized: plan.assignments.length,
      auto_assigned: autoAssigned,
      stale_flagged: staleFlagged,
      eta_reestimated: reestimated,
      unassignable: plan.unassignable.length,
      candidates: orders.items.filter((order) => !['completed', 'canceled', 'rejected'].includes(String(order.status))).length,
      algorithm: 'sos-capability-match-v2',
      triggered_by: actorOf(res).username ?? 'sos-operator',
      optimized_at: now(),
    });
  } catch (error) { next(error); }
});

for (const [action, patch] of [['complete', { status: 'completed', completed_at: now() }], ['reject', { status: 'canceled' }]] as const) {
  app.post(`/v1/emergency/dispatch/:id/${action}`, async (req, res, next) => {
    try { sendRecord(res, await update(client(req), DATASETS.dispatch, req.params.id, { ...patch, ...body(req) }, { ifVersion: requestedVersion(req) })); } catch (error) { next(error); }
  });
}

async function approveDispatch(req: Request, res: Response): Promise<void> {
  const c = client(req);
  const input = body(req);
  const actor = actorOf(res).username ?? 'sos-operator';
  const approvalId = String(input.approval_id || input.approvalId || '');
  let approval: any = null;
  if (hitlRequired() || approvalId) {
    if (!approvalId) throw new HitlError(428, 'approval_required', 'create a dispatch approval first');
    approval = await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'dispatch.assign', actor });
  }
  const resourceUnitId = requestedResourceUnitId(input);
  if (!resourceUnitId) throw badRequest('assigned_resource_unit_id_required', 'approve/assign needs an existing SOS resource unit id');
  const resource = await get(c, DATASETS.resources, resourceUnitId).catch((error) => {
    if (notFound(error)) throw notFoundError('resource_unit_not_found', `no resource unit ${resourceUnitId}`);
    throw error;
  });
  if (['offline', 'maintenance'].includes(String(resource.status))) {
    throw conflict('resource_unit_unavailable', `resource unit ${resourceUnitId} is ${resource.status}`);
  }
  const dispatchId = String(req.params.id);
  const current = await get(c, DATASETS.dispatch, dispatchId);
  const ifVersion = precondition(req, current);
  const assignments = Array.isArray(current.assignments) ? current.assignments : [];
  const alreadyAssigned = String(current.status) === 'assigned'
    && assignmentResourceUnitId(current) === resourceUnitId
    && assignments.some((assignment) => assignment && typeof assignment === 'object' && assignmentResourceUnitId(assignment) === resourceUnitId);
  if (alreadyAssigned) {
    // Repeating the same approval is a no-op, not a second write (issue #20).
    res.json({ ...current, idempotent: true });
    return;
  }
  const patch = normalizeDispatchAssignment(input, current.assignments, { status: 'assigned' });
  sendRecord(res, await update(c, DATASETS.dispatch, dispatchId, {
    ...patch,
    assigned_by: actor,
    ...(approval ? {
      approval_id: approval.id, approved_by: actor, approval_roles: approval.approverRoles,
      approved_at: new Date().toISOString(),
    } : {}),
  }, { ifVersion }));
}

// ---- shared HITL approvals (#24) ----
app.get('/v1/emergency/hitl/approvals', async (req, res, next) => {
  try {
    const items = await listPendingApprovals(req, req.query.module ? String(req.query.module) : undefined);
    const now = Date.now();
    res.json({ items: items.map((item) => ({ ...item, escalated: !!item.dueAt && Date.parse(item.dueAt) < now })), total: items.length });
  } catch (error) { next(error); }
});

app.post('/v1/emergency/hitl/approvals/:id/decide', async (req, res, next) => {
  try {
    const input = body(req);
    const decision = String(input.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    res.json({ approval: await decideApproval(req, req.params.id, decision as 'approve' | 'reject', input.note ? String(input.note) : undefined) });
  } catch (error) { next(error); }
});

app.post('/v1/emergency/hitl/handoff', async (req, res, next) => {
  try {
    const input = body(req);
    const outgoingRole = String(input.outgoing_role || 'duty-manager');
    const incomingRole = String(input.incoming_role || 'duty-manager');
    res.json(await buildHandoff(req, outgoingRole, incomingRole, input.notes ? String(input.notes) : undefined));
  } catch (error) { next(error); }
});

app.post('/v1/emergency/dispatch/:id/approval', async (req, res, next) => {
  try {
    const order = await get(client(req), DATASETS.dispatch, req.params.id);
    const actor = actorOf(res).username ?? 'sos-operator';
    const approval = await createApproval(req, {
      title: `Dispatch approval: ${String(order.title || order.id || req.params.id)}`,
      module: 'sos.dispatch', action: 'dispatch.assign', entityType: 'dispatch', entityId: String(req.params.id),
      payload: { incident_id: order.incident_id, priority: order.priority, resource_type: order.resource_type },
      requester: actor,
    });
    res.status(202).json({ approval, hitl_required: true });
  } catch (error) { next(error); }
});

app.post('/v1/emergency/eop/:id/approval', async (req, res, next) => {
  try {
    const plan = await get(client(req), DATASETS.eop, req.params.id);
    const actor = actorOf(res).username ?? 'sos-operator';
    const approval = await createApproval(req, {
      title: `EOP publication approval: ${String(plan.title || plan.id || req.params.id)}`,
      module: 'sos.eop', action: 'eop.approve', entityType: 'eop', entityId: String(req.params.id),
      payload: { event_id: plan.emergency_event_id, version: plan.version, status: plan.status },
      requester: actor,
    });
    res.status(202).json({ approval, hitl_required: true });
  } catch (error) { next(error); }
});

app.post('/v1/emergency/dispatch/:id/approve', async (req, res, next) => { try { await approveDispatch(req, res); } catch (error) { next(error); } });
app.post('/v1/emergency/dispatch/:id/assign', async (req, res, next) => { try { await approveDispatch(req, res); } catch (error) { next(error); } });

app.get('/v1/emergency/dispatch', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.dispatch);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/dispatch/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.dispatch, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/emergency/dispatch', async (req, res, next) => {
  try {
    const input = body(req);
    if (!input.emergency_event_id) throw badRequest('emergency_event_id_required');
    res.status(201).json(await write(client(req), DATASETS.dispatch, {
      ...input,
      status: input.status || 'pending',
      priority: input.priority || 'medium',
      assignments: input.assignments || [],
      metadata: input.metadata || {},
      created_by: actorOf(res).username ?? null,
    }));
  } catch (error) { next(error); }
});
app.put('/v1/emergency/dispatch/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.dispatch, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });

// ── Resource units ──────────────────────────────────────────────────────────

// ---- mutual aid (#23) ----
function mutualAidView(row: Data): Data { return row; }

app.get('/v1/emergency/public/mutual-aid/:id', async (req, res, next) => {
  try {
    const request = await get(client(req), DATASETS.mutualAid, req.params.id) as unknown as MutualAidRequest;
    res.json(publicMutualAidProjection(request));
  } catch (error) {
    if (notFound(error)) return res.status(404).json({ error: 'mutual_aid_not_found' });
    next(error);
  }
});

app.post('/v1/emergency/mutual-aid/requests', async (req, res, next) => {
  try {
    const input = body(req);
    const validated = validateRequest(input);
    if (!validated.ok) return res.status(400).json({ error: validated.error });
    const existing = await listAllRows(client(req), DATASETS.mutualAid);
    const duplicate = existing.items.find((row) => String(row.request_number || '') === String(validated.value.request_number));
    if (duplicate) return res.status(409).json({ error: 'duplicate_request', existing_id: duplicate.id });
    const id = String(input.id || randomUUID());
    const request = {
      id, ...validated.value, status: 'open', history: [{ action: 'created', at: now(), by: actorOf(res).username ?? 'sos-operator' }],
      created_at: now(), updated_at: now(), created_by: actorOf(res).username ?? null,
    };
    res.status(201).json(await write(client(req), DATASETS.mutualAid, request, id));
  } catch (error) { next(error); }
});

app.get('/v1/emergency/mutual-aid/requests', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.mutualAid);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data));
  } catch (error) { next(error); }
});

app.get('/v1/emergency/mutual-aid/requests/:id', async (req, res, next) => {
  try { sendRecord(res, await get(client(req), DATASETS.mutualAid, req.params.id)); } catch (error) { next(error); }
});

app.post('/v1/emergency/mutual-aid/requests/:id/accept', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.mutualAid, req.params.id) as unknown as MutualAidRequest & { record_version?: number };
    const input = body(req) as unknown as MutualAidAccept;
    const unit = await get(c, DATASETS.resources, String(input.unit_id || '')).catch((error) => {
      if (notFound(error)) throw notFoundError('resource_unit_not_found', `no resource unit ${input.unit_id}`);
      throw error;
    });
    const { remaining, available } = validateAccept(current, input, unit);
    const accepted = Number(input.accepted_quantity);
    const nextFilled = current.filled_quantity + accepted;
    const status = nextFilled >= current.quantity ? 'filled' : 'partially_filled';
    const unitVersion = Number(unit.record_version) || undefined;
    const updatedUnit = await update(c, DATASETS.resources, String(input.unit_id), {
      available_quantity: Math.max(0, available - accepted),
      updated_at: now(),
    }, { ifVersion: unitVersion }).catch((error) => {
      if (error instanceof CapabilitiesError && error.status === 409) throw conflict('resource_version_conflict', 'the resource unit changed; retry the accept');
      throw error;
    });
    try {
      const updated = await update(c, DATASETS.mutualAid, current.id, {
        filled_quantity: nextFilled, status, updated_at: now(),
        history: [...(current.history || []), { action: 'accept', unit_id: input.unit_id, accepted_quantity: accepted, eta_minutes: input.eta_minutes ?? null, at: now(), by: actorOf(res).username ?? 'sos-operator' }],
      }, { ifVersion: Number(current.record_version) || undefined });
      res.json({ request: updated, resource_unit: updatedUnit, remaining: Math.max(0, current.quantity - nextFilled) });
    } catch (error) {
      // Best-effort rollback keeps capacity consistent if the request update lost a race.
      await update(c, DATASETS.resources, String(input.unit_id), { available_quantity: available, updated_at: now() }, { ifVersion: Number(updatedUnit.record_version) || undefined }).catch(() => undefined);
      if (error instanceof CapabilitiesError && error.status === 409) throw conflict('request_version_conflict', 'the request changed; retry the accept');
      throw error;
    }
  } catch (error) { next(error); }
});

app.post('/v1/emergency/mutual-aid/requests/:id/decline', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.mutualAid, req.params.id) as unknown as MutualAidRequest & { record_version?: number };
    if (!['open', 'partially_filled'].includes(current.status)) throw conflict('request_not_open', `request is ${current.status}`);
    const input = body(req);
    sendRecord(res, await update(c, DATASETS.mutualAid, current.id, {
      status: 'declined', decline_reason: input.reason ? String(input.reason).slice(0, 500) : null, updated_at: now(),
      history: [...(current.history || []), { action: 'decline', reason: input.reason ?? null, at: now(), by: actorOf(res).username ?? 'sos-operator' }],
    }, { ifVersion: Number(current.record_version) || undefined }));
  } catch (error) { next(error); }
});

app.post('/v1/emergency/mutual-aid/requests/:id/handoff', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.mutualAid, req.params.id) as unknown as MutualAidRequest & { record_version?: number };
    const input = body(req);
    sendRecord(res, await update(c, DATASETS.mutualAid, current.id, {
      status: 'handed_off', handed_off_to: String(input.to_agency || '').slice(0, 200), handoff_notes: input.notes ? String(input.notes).slice(0, 2000) : null,
      updated_at: now(),
      history: [...(current.history || []), { action: 'handoff', to_agency: input.to_agency ?? null, at: now(), by: actorOf(res).username ?? 'sos-operator' }],
    }, { ifVersion: Number(current.record_version) || undefined }));
  } catch (error) { next(error); }
});

app.get('/v1/emergency/resources/shelters/near', async (req, res, next) => {
  try {
    const origin = parseNearQuery({ ...req.query, radius_m: req.query.radius_m ?? 20_000 });
    const { items } = await listAllRows(client(req), DATASETS.resources);
    const shelters = items
      .filter((resource) => String(resource.resource_type ?? '') === 'shelter')
      .filter((resource) => !['offline', 'maintenance'].includes(String(resource.status ?? '')))
      .map((resource) => {
        const distance = hazardDistanceMeters({ geometry: resource.current_location }, { lat: origin.lat, lng: origin.lng });
        return { resource, distance };
      })
      .filter((entry): entry is { resource: Data; distance: number } => entry.distance !== null && entry.distance <= origin.radiusM)
      .sort((a, b) => a.distance - b.distance)
      .slice(origin.offset, origin.offset + origin.limit)
      .map((entry) => ({
        id: entry.resource.id,
        name: entry.resource.name,
        resource_code: entry.resource.resource_code ?? null,
        district: entry.resource.district ?? null,
        ward: entry.resource.ward ?? null,
        capacity: entry.resource.capacity ?? null,
        capacity_unit: entry.resource.capacity_unit ?? null,
        status: entry.resource.status ?? null,
        contact_phone: entry.resource.contact_phone ?? null,
        current_location: entry.resource.current_location ?? null,
        distance_m: Math.round(entry.distance),
      }));
    res.json({ shelters, radius_m: origin.radiusM, total: shelters.length });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/resources', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.resources);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/resources/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.resources, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/emergency/resources', async (req, res, next) => {
  try {
    const input = body(req);
    if (!input.name || !input.resource_type) throw badRequest('name_and_resource_type_required');
    res.status(201).json(await write(client(req), DATASETS.resources, {
      ...input,
      resource_code: input.resource_code || `RU-${Date.now()}`,
      status: input.status || 'available',
      skills: input.skills || [],
      metadata: input.metadata || {},
    }));
  } catch (error) { next(error); }
});
app.put('/v1/emergency/resources/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.resources, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });
app.post('/v1/emergency/resources/:id/status', async (req, res, next) => {
  try {
    const input = body(req);
    if (!input.status) throw badRequest('status_required');
    res.json(await update(client(req), DATASETS.resources, req.params.id, { status: input.status, status_changed_at: now() }, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});

// ── SITREP ──────────────────────────────────────────────────────────────────

app.get('/v1/emergency/sitrep', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.sitrep);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/sitrep/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.sitrep, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/emergency/sitrep', async (req, res, next) => {
  try {
    const input = body(req);
    const validation = validateSitrepCreate(input, actorOf(res));
    if (validation.errors.length > 0) throw badRequest('sitrep_validation_failed', 'SITREP payload is invalid', validation.errors);
    const eventId = String(validation.value.emergency_event_id);
    await get(client(req), DATASETS.events, eventId).catch((error) => {
      if (notFound(error)) throw badRequest('emergency_event_not_found', `no emergency event ${eventId}`);
      throw error;
    });
    res.status(201).json(await write(client(req), DATASETS.sitrep, {
      ...validation.value,
      version: 1,
      deltas: [],
      snapshot: validation.value.snapshot || {},
      metadata: validation.value.metadata || {},
      created_by: actorOf(res).username ?? null,
    }));
  } catch (error) { next(error); }
});
app.put('/v1/emergency/sitrep/:id', async (req, res, next) => {
  try {
    const current = await get(client(req), DATASETS.sitrep, req.params.id);
    const validation = validateSitrepUpdate(body(req), current);
    if (validation.errors.length > 0) throw badRequest('sitrep_validation_failed', 'SITREP payload is invalid', validation.errors);
    res.json(await update(client(req), DATASETS.sitrep, req.params.id, { ...validation.value, updated_by: actorOf(res).username ?? null }, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});
app.post('/v1/emergency/sitrep/:id/delta', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.sitrep, req.params.id);
    const delta = body(req);
    if (String(current.status) === 'published' || String(current.status) === 'archived') {
      const revision = revisionFromDelta(current, delta, actorOf(res), now());
      const created = await write(c, DATASETS.sitrep, revision, String(revision.id));
      res.status(201).json({ ...created, superseded_sitrep_id: current.id });
      return;
    }
    const deltas = Array.isArray(current.deltas) ? current.deltas : [];
    res.json(await update(c, DATASETS.sitrep, req.params.id, {
      deltas: [...deltas, { ...delta, actor_id: actorOf(res).username ?? null, created_at: now() }],
    }, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});
app.post('/v1/emergency/sitrep/:id/publish', async (req, res, next) => {
  try {
    const c = client(req);
    const current = await get(c, DATASETS.sitrep, req.params.id);
    assertPublishable(current);
    res.json(await update(c, DATASETS.sitrep, req.params.id, {
      status: 'published',
      published_at: now(),
      published_by: actorOf(res).username ?? null,
      reviewed_by: actorOf(res).username ?? null,
    }, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});

// ── AAR ─────────────────────────────────────────────────────────────────────

async function loadAarInputs(c: CapabilitiesClient, event: Data) {
  const [orders, sitreps, resources] = await Promise.all([
    listAllRows(c, DATASETS.dispatch),
    listAllRows(c, DATASETS.sitrep),
    listAllRows(c, DATASETS.resources),
  ]);
  const eventId = String(event.id);
  return {
    orders: orders.items.filter((order) => String(order.emergency_event_id ?? '') === eventId),
    sitreps: sitreps.items.filter((sitrep) => String(sitrep.emergency_event_id ?? '') === eventId),
    resources: resources.items,
  };
}

async function findAarsForEvent(c: CapabilitiesClient, eventId: string): Promise<Data[]> {
  const { items } = await listAllRows(c, DATASETS.afterAction);
  return items
    .filter((report) => String(report.emergency_event_id ?? '') === eventId)
    .sort((a, b) => (Number(a.version) || 1) - (Number(b.version) || 1));
}

async function generateAar(c: CapabilitiesClient, event: Data, options: { force?: boolean; summaryOverride?: string; actor?: string } = {}): Promise<Data> {
  const existing = await findAarsForEvent(c, String(event.id));
  if (!options.force && existing.length > 0) return { ...existing[existing.length - 1], idempotent: true };
  const version = existing.length === 0 ? 1 : Math.max(...existing.map((report) => Number(report.version) || 1)) + 1;
  const id = `aar-${String(event.id)}-v${version}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180);
  const same = await get(c, DATASETS.afterAction, id).catch((error) => { if (notFound(error)) return null; throw error; });
  if (same) return same;
  const inputs = await loadAarInputs(c, event);
  const computed = computeAfterAction({ event, ...inputs });
  return write(c, DATASETS.afterAction, {
    id,
    emergency_event_id: event.id,
    report_code: `AAR-${String(event.event_code ?? event.id)}-v${version}`,
    title: `After-action report — ${String(event.title ?? event.id)}`,
    summary: options.summaryOverride || computed.summary,
    status: 'draft',
    version,
    timeline: computed.timeline,
    kpi: computed.kpi,
    lessons_learned: [],
    recommendations: [],
    generated_by: 'sos-kpi-engine-v1',
    generated_at: now(),
    metadata: { ...computed.metadata, generated_by_user: options.actor ?? null },
  }, id);
}

app.post('/v1/emergency/after-action/generate', async (req, res, next) => {
  try {
    const input = body(req);
    const eventId = String(input.emergency_event_id ?? '').trim();
    if (!eventId) throw badRequest('emergency_event_id_required');
    const event = await get(client(req), DATASETS.events, eventId).catch((error) => {
      if (notFound(error)) throw notFoundError('emergency_event_not_found', `no emergency event ${eventId}`);
      throw error;
    });
    const report = await generateAar(client(req), event, {
      force: parseBoolean(input.force_regenerate) === true,
      summaryOverride: typeof input.summary_override === 'string' ? input.summary_override : undefined,
      actor: actorOf(res).username,
    });
    res.status(report.idempotent ? 200 : 201).json(report);
  } catch (error) { next(error); }
});
app.post('/v1/emergency/after-action/:id/publish', async (req, res, next) => {
  try {
    const current = await get(client(req), DATASETS.afterAction, req.params.id);
    if (String(current.status) === 'published') throw conflict('aar_already_published');
    if (!current.kpi || typeof current.kpi !== 'object') throw badRequest('aar_kpi_required', 'generate the AAR KPI before publishing');
    res.json(await update(client(req), DATASETS.afterAction, req.params.id, {
      status: 'published',
      published_at: now(),
      published_by: actorOf(res).username ?? null,
    }, { ifVersion: requestedVersion(req) }));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/after-action', async (req, res, next) => {
  try {
    const { items, truncated } = await listAllRows(client(req), DATASETS.afterAction);
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/after-action/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.afterAction, req.params.id)); } catch (error) { next(error); } });
app.put('/v1/emergency/after-action/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.afterAction, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });

// Keep the event id route after all named emergency collections.
app.get('/v1/emergency/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.events, req.params.id)); } catch (error) { next(error); } });
app.put('/v1/emergency/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.events, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });
app.post('/v1/emergency/:id/resolve', async (req, res, next) => {
  try {
    const c = client(req);
    const input = body(req);
    const event = await get(c, DATASETS.events, req.params.id);
    if (String(event.status) === 'resolved') {
      const reports = await findAarsForEvent(c, String(event.id));
      res.json({ ...event, after_action_report_id: reports.length ? reports[reports.length - 1].id : null, idempotent: true });
      return;
    }
    const resolvedPreview: Data = {
      ...event,
      status: 'resolved',
      ended_at: input.ended_at || now(),
      resolution_note: input.resolution_note ?? event.resolution_note ?? null,
      resolved_by: actorOf(res).username ?? null,
    };
    // Create the AAR first so a dependency failure does not leave a resolved
    // event without its after-action report.
    const report = await generateAar(c, resolvedPreview, { actor: actorOf(res).username });
    const resolved = await update(c, DATASETS.events, req.params.id, {
      status: 'resolved',
      ended_at: resolvedPreview.ended_at,
      resolution_note: resolvedPreview.resolution_note,
      after_action_report_id: report.id,
      resolved_by: resolvedPreview.resolved_by,
    }, { ifVersion: Number(event.record_version) || undefined });
    res.json({ ...resolved, after_action_report_id: report.id });
  } catch (error) { next(error); }
});

// ── Hazards ─────────────────────────────────────────────────────────────────

async function allHazards(c: CapabilitiesClient) {
  return listAllRows(c, DATASETS.hazards);
}

app.get('/v1/hazards/recent', async (req, res, next) => {
  try {
    const hours = parseNumber(req.query.hours, { min: 1, max: 24 * 365, fallback: 24 }) ?? 24;
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const { items } = await listAllPublic(client(req), DATASETS.hazards);
    const hazards = items
      .filter((hazard) => hazard.is_active !== false && hazard.status !== 'expired')
      .filter((hazard) => {
        const stamp = recordTimestamp(hazard);
        return stamp !== null && stamp >= cutoff;
      })
      .slice(offsetOf(req), offsetOf(req) + limitOf(req, 200))
      .map((hazard) => ({
        ...hazard,
        linked_event_id: hazard.linked_event_id || null,
        linked_eop_plan_id: hazard.linked_eop_plan_id || null,
      }));
    res.json(hazards);
  } catch (error) { next(error); }
});

app.get('/v1/hazards/geo/near', async (req, res, next) => {
  try {
    const query = parseNearQuery(req.query as Data);
    const { items } = await allHazards(client(req));
    res.json(nearHazards(items, query));
  } catch (error) { next(error); }
});

app.post('/v1/hazards/geo/in-polygon', async (req, res, next) => {
  try {
    const input = body(req);
    const area = validatePolygon(input.polygon ?? input.geometry ?? input);
    const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 200), 1), 500);
    const offset = Math.max(Math.floor(Number(input.skip ?? input.offset) || 0), 0);
    const { items } = await allHazards(client(req));
    res.json(inPolygonHazards(items, area, { limit, offset }));
  } catch (error) { next(error); }
});

app.get('/v1/hazards/ingest/status', async (req, res, next) => {
  try {
    const c = client(req);
    const [latest, connector] = await Promise.all([latestIngestRun(c), vndmsConnectorStatus(c)]);
    res.json(ingestStatusFromRun(latest, Date.now(), connector));
  } catch (error) { next(error); }
});

app.post('/v1/hazards/ingest', async (req, res, next) => {
  try {
    const c = client(req);
    const input = body(req);
    const batch = normalizeIngestBatch(input.records ?? [], now());
    if (batch.accepted.length === 0 && batch.rejected.length === 0) throw badRequest('empty_ingest_batch');
    const existing = await allHazards(c);
    const byHazardId = new Map(existing.items.map((hazard) => [String(hazard.hazard_id ?? hazard.id), hazard]));
    let ingested = 0;
    for (const entry of batch.accepted) {
      const hazard = entry.hazard;
      const stableId = `vndms-${String(hazard.hazard_id)}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180);
      const current = byHazardId.get(String(hazard.hazard_id));
      const recordId = current ? String(current.id) : stableId;
      const merged = {
        ...(current ?? {}),
        ...hazard,
        id: recordId,
        linked_event_id: current?.linked_event_id ?? null,
        linked_eop_plan_id: current?.linked_eop_plan_id ?? null,
      };
      if (current) {
        const saved = await update(c, DATASETS.hazards, recordId, merged, { ifVersion: Number(current.record_version) || undefined });
        byHazardId.set(String(hazard.hazard_id), saved);
      } else {
        const saved = await write(c, DATASETS.hazards, merged, recordId);
        byHazardId.set(String(hazard.hazard_id), saved);
      }
      ingested += 1;
    }
    const previousRuns = await listAllRows(c, DATASETS.hazardRuns).catch(() => ({ items: [], truncated: false }));
    const previousSuccess = previousRuns.items
      .filter((run) => String(run.status) === 'succeeded' || String(run.status) === 'partial')
      .map((run) => String(run.finished_at ?? run.created_at ?? ''))
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    const run = {
      source: 'vndms',
      started_at: input.started_at ? String(input.started_at) : now(),
      finished_at: now(),
      status: batch.rejected.length === 0 ? 'succeeded' : 'partial',
      records_received: batch.accepted.length + batch.rejected.length,
      records_ingested: ingested,
      records_rejected: batch.rejected.length,
      error: batch.rejected.length > 0 ? `${batch.rejected.length} record(s) rejected` : null,
      feed_version: input.feed_version ? String(input.feed_version) : null,
      last_success_at: previousSuccess,
      rejected: batch.rejected,
    };
    const successAt = run.status === 'succeeded' || run.status === 'partial'
      ? run.finished_at
      : previousSuccess;
    const storedRun = await write(c, DATASETS.hazardRuns, { ...run, last_success_at: successAt });
    const status = ingestStatusFromRun({ ...storedRun, last_success_at: successAt });
    res.status(201).json({ run: storedRun, status, ingested, rejected: batch.rejected });
  } catch (error) { next(error); }
});

app.get('/v1/hazards/vndms-live', async (req, res, next) => {
  try {
    const { items } = await listAllPublic(client(req), DATASETS.hazards);
    const hazards = items
      .filter((hazard) => isVndmsRecord(hazard) && hazard.is_active !== false && hazard.status !== 'expired')
      .map(toVndmsHazard)
      .filter((hazard): hazard is NonNullable<typeof hazard> => hazard !== null)
      .slice(offsetOf(req), offsetOf(req) + limitOf(req, 200));
    res.json(hazards);
  } catch (error) { next(error); }
});

app.post('/v1/hazards/expire-stale', async (req, res, next) => {
  try {
    const ttlHours = hazardTtlHours(req.body?.ttl_hours);
    const nowMs = Date.now();
    const { items, scanned, truncated } = await allHazards(client(req));
    let updated = 0;
    for (const hazard of items) {
      if (!isHazardStale(hazard, nowMs, ttlHours)) continue;
      await update(client(req), DATASETS.hazards, String(hazard.id), { is_active: false, status: 'expired', expired_at: now() }, { ifVersion: Number(hazard.record_version) || undefined });
      updated += 1;
    }
    res.json({ scanned, updated, truncated });
  } catch (error) { next(error); }
});

app.get('/v1/hazards', async (req, res, next) => {
  try {
    const { items, truncated, scanned } = await allHazards(client(req));
    if (truncated) res.setHeader('x-sos-scan-truncated', 'true');
    res.setHeader('x-sos-records-scanned', String(scanned));
    res.json(filterRows(items, req.query as Data).slice(offsetOf(req), offsetOf(req) + limitOf(req)));
  } catch (error) { next(error); }
});
app.get('/v1/hazards/:id', async (req, res, next) => { try { sendRecord(res, await get(client(req), DATASETS.hazards, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/hazards', async (req, res, next) => {
  try {
    const input = body(req);
    if (!input.title || !input.event_type) throw badRequest('title_and_event_type_required');
    res.status(201).json(await write(client(req), DATASETS.hazards, {
      ...input,
      is_active: input.is_active !== false,
      status: input.status || (input.is_active === false ? 'expired' : 'active'),
      severity: input.severity || 'medium',
      source: input.source || 'manual',
      metadata: input.metadata || {},
      linked_event_id: input.linked_event_id ?? null,
      linked_eop_plan_id: input.linked_eop_plan_id ?? null,
    }));
  } catch (error) { next(error); }
});
app.put('/v1/hazards/:id', async (req, res, next) => { try { sendRecord(res, await update(client(req), DATASETS.hazards, req.params.id, body(req), { ifVersion: requestedVersion(req) })); } catch (error) { next(error); } });

app.post('/v1/hazards/:id/deploy', async (req, res, next) => {
  try {
    const c = client(req);
    const hazardId = req.params.id;
    const result = await withLock(`deploy:${hazardId}`, async () => {
      const hazard = await get(c, DATASETS.hazards, hazardId);
      if (hazard.linked_event_id) {
        const existingEvent = await get(c, DATASETS.events, String(hazard.linked_event_id));
        const existingPlan = hazard.linked_eop_plan_id
          ? await get(c, DATASETS.eop, String(hazard.linked_eop_plan_id)).catch(() => null)
          : (await findPlansForEvent(c, String(existingEvent.id))).pop() ?? null;
        return {
          hazard_id: String(hazard.id),
          event_id: String(existingEvent.id),
          eop_plan_id: existingPlan ? String(existingPlan.id) : null,
          markdown_body: typeof existingPlan?.markdown_body === 'string' ? existingPlan.markdown_body : null,
          hazard,
          event: existingEvent,
          eop_plan: existingPlan,
          idempotent: true,
          generated: false,
        };
      }
      const event = await write(c, DATASETS.events, {
        id: `event-${String(hazard.id)}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 180),
        title: hazard.title,
        description: hazard.description,
        event_type: hazard.event_type,
        severity: hazard.severity,
        source: 'forecast',
        status: 'active',
        started_at: now(),
        location: { district: hazard.district, ward: hazard.ward },
        geometry: hazard.geometry,
        affected_asset_ids: [],
        estimated_impact: {},
        instructions: [],
        tags: [],
        metadata: { hazard_id: hazard.hazard_id || hazard.id },
        created_by: actorOf(res).username ?? null,
      });
      // Deploy must always produce a usable plan, so an unavailable AI is
      // labelled in the plan metadata instead of blocking incident creation.
      const { plan } = await createEopVersion(c, event, 1, {
        title: `EOP — ${String(event.title)}`,
        allowDeterministicFallback: true,
        correlationId: res.getHeader('x-correlation-id')?.toString(),
      });
      let updatedHazard: Data;
      try {
        updatedHazard = await update(c, DATASETS.hazards, hazardId, { linked_event_id: event.id, linked_eop_plan_id: plan.id }, {
          ifVersion: Number(hazard.record_version) || undefined,
        });
      } catch (error) {
        // A concurrent deploy won the link update; the deterministic event and
        // plan ids mean the result is the same. Return the persisted link.
        if (error instanceof HttpError && error.code === 'record_version_conflict') {
          const latest = await get(c, DATASETS.hazards, hazardId);
          if (latest.linked_event_id) {
            const linkedEvent = await get(c, DATASETS.events, String(latest.linked_event_id));
            const linkedPlan = latest.linked_eop_plan_id
              ? await get(c, DATASETS.eop, String(latest.linked_eop_plan_id)).catch(() => null)
              : null;
            return {
              hazard_id: String(latest.id),
              event_id: String(linkedEvent.id),
              eop_plan_id: linkedPlan ? String(linkedPlan.id) : null,
              markdown_body: typeof linkedPlan?.markdown_body === 'string' ? linkedPlan.markdown_body : null,
              hazard: latest,
              event: linkedEvent,
              eop_plan: linkedPlan,
              idempotent: true,
              generated: false,
            };
          }
        }
        throw error;
      }
      return {
        hazard_id: String(updatedHazard.id),
        event_id: String(event.id),
        eop_plan_id: String(plan.id),
        markdown_body: typeof plan.markdown_body === 'string' ? plan.markdown_body : null,
        hazard: updatedHazard,
        event,
        eop_plan: plan,
        idempotent: false,
        generated: true,
      };
    });
    res.json(result);
  } catch (error) { next(error); }
});

// ── Hazard SSE ──────────────────────────────────────────────────────────────

function lastEventIdOf(req: Request): string | null {
  const header = req.header('last-event-id');
  const query = typeof req.query.last_event_id === 'string' ? req.query.last_event_id : null;
  const value = (header ?? query ?? '').trim();
  return value || null;
}

function eventFeedSupported(c: CapabilitiesClient): boolean {
  const events = (c as unknown as { events?: { list?: unknown } }).events;
  return Boolean(events && typeof events.list === 'function');
}

app.get('/v1/emergency/stream/hazards', async (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(': connected\n\n');
  res.write('retry: 5000\n\n');

  const c = client(req);
  let lastGood: Data[] | null = null;
  let lastGoodAt: string | null = null;
  let closed = false;
  // Resume from the Tier-2 event cursor the client last saw (issue #19).
  let cursor = lastEventIdOf(req);
  let transport: 'events' | 'snapshot-poll' = eventFeedSupported(c) ? 'events' : 'snapshot-poll';
  let ticksSinceSnapshot = 0;
  const pollTicks = Math.max(1, Math.ceil(30_000 / STREAM_EVENT_POLL_MS));

  const refresh = async (source: 'initial' | 'event' | 'poll', frameId?: string | null): Promise<boolean> => {
    if (closed) return false;
    const started = Date.now();
    try {
      const { items } = await listAllPublic(c, DATASETS.hazards);
      lastGood = items;
      lastGoodAt = now();
      ticksSinceSnapshot = 0;
      recordDependency('synapsedx', true, Date.now() - started);
      res.write(sseHazardsFrame({
        snapshot: items,
        degraded: false,
        last_good_at: lastGoodAt,
        transport,
        source,
      }, frameId ?? undefined));
      return true;
    } catch (error) {
      recordDependency('synapsedx', false, Date.now() - started, (error as Error).message);
      // Never synthesise an empty snapshot. Emit a named error event and keep
      // the last good snapshot so the client can show "unavailable" instead of
      // an all-clear (issue #10).
      res.write(sseErrorFrame({
        error: 'hazard_stream_degraded',
        message: 'Hazard data is temporarily unavailable.',
        retry_ms: 5000,
        last_good_at: lastGoodAt,
        has_snapshot: lastGood !== null,
        transport,
      }));
      console.error(JSON.stringify({
        level: 'warn',
        service: 'synapsecity-sos',
        msg: 'hazard_stream_degraded',
        error: (error as Error).message,
        correlation_id: res.getHeader('x-correlation-id')?.toString(),
      }));
      return false;
    }
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    if (transport === 'events') {
      const started = Date.now();
      try {
        const feed = await c.events.list({
          ...(cursor ? { since: cursor } : {}),
          datasetId: DATASETS.hazards.id,
          limit: 100,
        });
        const items = Array.isArray(feed?.items) ? feed.items : [];
        const next = feed?.nextCursor ?? (items.length ? items[items.length - 1].id : null);
        if (next) cursor = String(next);
        recordDependency('synapsedx-events', true, Date.now() - started);
        const relevant = items.filter((item) => {
          const event = item?.event;
          if (!event) return false;
          if (!String(event.type ?? '').startsWith('record.')) return false;
          return !event.datasetId || event.datasetId === DATASETS.hazards.id;
        });
        if (relevant.length) {
          await refresh('event', cursor);
        }
        return;
      } catch (error) {
        recordDependency('synapsedx-events', false, Date.now() - started, (error as Error).message);
        incrementCounter('hazard_stream', { transport: 'snapshot-poll' });
        transport = 'snapshot-poll';
        ticksSinceSnapshot = pollTicks - 1;
      }
    }
    ticksSinceSnapshot += 1;
    if (ticksSinceSnapshot >= pollTicks) await refresh('poll');
  };

  await refresh('initial');
  incrementCounter('hazard_stream', { transport: transport === 'events' ? 'event-feed' : 'snapshot-poll' });

  const snapshotTimer = setInterval(() => { void tick(); }, STREAM_EVENT_POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (closed) return;
    res.write(sseHeartbeatFrame());
  }, 15000);
  req.on('close', () => {
    closed = true;
    clearInterval(snapshotTimer);
    clearInterval(heartbeatTimer);
  });
});

// ── Geo / map / AI ──────────────────────────────────────────────────────────

app.get('/v1/geo/search-address', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json([]);
    const suggestions = await vietMapAutocomplete(query);
    const enriched = await Promise.all(suggestions.slice(0, 5).map(async (item) => {
      const place = item.ref_id ? await vietMapPlace(item.ref_id).catch(() => null) : null;
      return { address: item.display || item.address || item.name || query, coordinates: { latitude: Number(place?.lat || 0), longitude: Number(place?.lng || 0) }, city: place?.city || '', country: 'Vietnam', ref_id: item.ref_id };
    }));
    res.json(enriched.filter((item) => item.coordinates.latitude !== 0 || item.coordinates.longitude !== 0));
  } catch (error) { next(error); }
});
app.post('/v1/geo/geocode', async (req, res, next) => {
  try {
    const text = String(req.body?.address || '').trim();
    if (!text) return res.status(400).json({ error: 'address_required' });
    const [match] = await vietMapGeocode(text);
    if (!match?.ref_id) return res.status(404).json({ error: 'address_not_found' });
    const place = await vietMapPlace(match.ref_id);
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return res.status(404).json({ error: 'coordinates_not_found' });
    res.json({ coordinates: { latitude: place.lat, longitude: place.lng }, geojson: { type: 'Point', coordinates: [place.lng, place.lat] }, display_name: place.display || match.display || text });
  } catch (error) { next(error); }
});
app.post('/v1/geo/reverse-geocode', async (req, res, next) => {
  try {
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'coordinates_required' });
    const [place] = await vietMapReverse(latitude, longitude);
    if (!place) return res.status(404).json({ error: 'address_not_found' });
    res.json({ address: place.display || place.address || '', city: place.city || '', country: 'Vietnam' });
  } catch (error) { next(error); }
});
app.get('/v1/map/config', (_req, res) => res.json(vietMapConfigured() ? { provider: 'vietmap', tileUrl: '/v1/map/tiles/{z}/{x}/{y}.png', attribution: '&copy; VIETMAP', maxZoom: 20, maxNativeZoom: 20, style: vietMapTileStyle() } : { provider: 'openstreetmap', tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 20, maxNativeZoom: 19 }));
app.get('/v1/map/tiles/:z/:x/:y.png', async (req, res, next) => { try { await proxyVietMapTile(Number(req.params.z), Number(req.params.x), Number(req.params.y), res); } catch (error) { next(error); } });
app.get('/v1/map/status', (_req, res) => res.json({ provider: vietMapConfigured() ? 'vietmap' : 'openstreetmap', configured: vietMapConfigured(), service: 'synapsecity-sos' }));

app.get('/v1/ai/status', async (req, res, next) => {
  try {
    const status = await aiStatus(client(req), PUBLIC_TIER2_URL);
    res.setHeader('cache-control', 'no-store');
    res.json({
      status: status.status === 'ok' ? 'ok' : 'unavailable',
      configured: status.configured,
      provider: status.provider,
      model: status.model,
      capability: 'ai',
      dependency: status.dependency,
      detail: status.detail,
      checked_at: status.checked_at,
      base_url: PUBLIC_TIER2_URL,
    });
  } catch (error) { next(error); }
});

app.post('/v1/ai/chat', async (req, res, next) => {
  try {
    const input = body(req);
    const rawMessages = Array.isArray(input.messages)
      ? input.messages
      : typeof input.message === 'string'
        ? [{ role: 'user', content: input.message }]
        : typeof input.prompt === 'string'
          ? [{ role: 'user', content: input.prompt }]
          : null;
    if (!rawMessages || !rawMessages.length) throw badRequest('messages_required', 'pass messages[], message or prompt');
    if (rawMessages.length > 50) throw badRequest('too_many_messages', 'at most 50 chat messages are accepted');
    const messages = rawMessages.map((entry, index) => {
      if (!entry || typeof entry !== 'object') throw badRequest('invalid_message', `messages[${index}] must be an object`);
      const message = entry as Data;
      const role = String(message.role ?? 'user');
      if (!['system', 'user', 'assistant'].includes(role)) throw badRequest('invalid_message_role', `messages[${index}].role must be system|user|assistant`);
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content) throw badRequest('invalid_message_content', `messages[${index}].content is required`);
      return { role: role as 'system' | 'user' | 'assistant', content };
    });
    const result = await aiChat(client(req), messages, {
      ...(typeof input.model === 'string' ? { model: input.model } : {}),
      ...(Number.isFinite(Number(input.temperature)) ? { temperature: Number(input.temperature) } : {}),
      ...(Number.isFinite(Number(input.max_tokens)) ? { maxTokens: Number(input.max_tokens) } : {}),
      correlationId: res.getHeader('x-correlation-id')?.toString(),
    });
    res.json({ provider: result.provider, model: result.model, content: result.content, usage: result.usage });
  } catch (error) { next(error); }
});

// Final /v1 fallback.
app.use((req, res, next) => {
  const path = normalizedPath(req.originalUrl);
  if (path !== '/v1' && !path.startsWith('/v1/')) return next();
  res.status(404).json({ error: 'not_found', product: 'synapsecity-sos' });
});

app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
  const correlationId = res.getHeader('x-correlation-id')?.toString();
  if (error instanceof HitlError) {
    res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    return;
  }
  if (error instanceof CapabilitiesError) {
    console.error(JSON.stringify({ level: 'error', service: 'synapsecity-sos', msg: 'tier2_error', status: error.status, error: error.message, correlation_id: correlationId }));
    const status = error.status === 404 ? 404 : 502;
    res.status(status).json({ error: status === 404 ? 'not_found' : 'tier2_unavailable' });
    return;
  }
  const status = Number(error?.status) || 500;
  if (status >= 500) {
    console.error(JSON.stringify({ level: 'error', service: 'synapsecity-sos', msg: 'unhandled_error', error: error?.message, correlation_id: correlationId }));
  }
  res.status(status).json({ error: error?.message || 'sos_service_error' });
});

if (require.main === module) {
  assertAuthConfiguration();
  app.listen(PORT, () => console.log(`[synapsecity-sos] emergency service listening on :${PORT}; Tier-2=${PUBLIC_TIER2_URL}`));
}
export { app };
