// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * VNDMS hazard wire contract and ingestion normalisation.
 *
 * The public VNDMS layer expects flat coordinates (`lat`/`lon`) plus
 * `warning_type`/`warning_level`, while stored SOS hazards use GeoJSON
 * `geometry`. This module is the single place that converts between the two.
 *
 * Ingestion is push-based: a Tier-2 scheduled connector (SynapseDX scheduled
 * work) posts a feed batch to `POST /v1/hazards/ingest`. SOS validates,
 * normalises and upserts by stable `hazard_id`, then records the run in
 * `sos-hazard-ingest-runs`. SOS never runs a cron/poller of its own.
 */
import { badRequest } from './errors';
import type { Data } from './filters';

export type VndmsWarningType =
  | 'water_level'
  | 'warning_rain'
  | 'warning_wind'
  | 'warning_earthquake'
  | 'warning_flood';

export type VndmsSeverity = 'low' | 'medium' | 'high';

export interface VndmsHazard {
  id: string;
  hazard_id: string;
  lat: number;
  lon: number;
  label: string;
  warning_type: VndmsWarningType;
  warning_level: number;
  severity: VndmsSeverity;
  value: string;
  popupInfo: string;
  source: 'vndms';
  is_active: boolean;
  observed_at: string | null;
  expires_at: string | null;
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
}

const WARNING_TYPES = new Set<VndmsWarningType>([
  'water_level',
  'warning_rain',
  'warning_wind',
  'warning_earthquake',
  'warning_flood',
]);

const EVENT_TO_WARNING: Record<string, VndmsWarningType> = {
  flood: 'warning_flood',
  storm: 'warning_wind',
  landslide: 'warning_rain',
  earthquake: 'warning_earthquake',
  heavy_rain: 'warning_rain',
  rainfall: 'warning_rain',
  water_level: 'water_level',
};

const SEVERITY_TO_LEVEL: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 3 };
const LEVEL_TO_SEVERITY: Record<number, VndmsSeverity> = { 1: 'low', 2: 'medium', 3: 'high' };

function pointOf(row: Data): { lat: number; lon: number } | null {
  const geometry = row.geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const lon = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  const metadata = (row.metadata as Data | undefined) ?? {};
  const lat = Number(row.lat ?? metadata.lat);
  const lon = Number(row.lon ?? row.lng ?? metadata.lon ?? metadata.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  return null;
}

export function warningTypeOf(row: Data): VndmsWarningType {
  const raw = String(row.warning_type ?? (row.metadata as Data | undefined)?.warning_type ?? '').trim();
  if (WARNING_TYPES.has(raw as VndmsWarningType)) return raw as VndmsWarningType;
  const eventType = String(row.event_type ?? '').toLowerCase();
  return EVENT_TO_WARNING[eventType] ?? 'warning_flood';
}

export function warningLevelOf(row: Data): number {
  const raw = Number(row.warning_level ?? (row.metadata as Data | undefined)?.warning_level);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(3, Math.floor(raw));
  return SEVERITY_TO_LEVEL[String(row.severity ?? '')] ?? 2;
}

export function severityOf(row: Data): VndmsSeverity {
  const level = warningLevelOf(row);
  const severity = String(row.severity ?? '');
  if (severity === 'critical') return 'high';
  if (severity === 'high' || severity === 'medium' || severity === 'low') return severity as VndmsSeverity;
  return LEVEL_TO_SEVERITY[level] ?? 'medium';
}

export function isVndmsRecord(row: Data): boolean {
  const source = String(row.source ?? (row.metadata as Data | undefined)?.source ?? '').toLowerCase();
  return source === 'vndms' || row.warning_type !== undefined || (row.metadata as Data | undefined)?.warning_type !== undefined;
}

/** Convert a stored hazard record to the flat VNDMS wire schema. */
export function toVndmsHazard(row: Data): VndmsHazard | null {
  const point = pointOf(row);
  if (!point) return null;
  const severity = severityOf(row);
  const warningType = warningTypeOf(row);
  const warningLevel = warningLevelOf(row);
  const district = String(row.district ?? '');
  const description = String(row.description ?? '');
  const observedAt = String(row.observed_at ?? row.created_at ?? '') || null;
  return {
    id: String(row.id),
    hazard_id: String(row.hazard_id ?? row.id),
    lat: point.lat,
    lon: point.lon,
    label: String(row.title ?? row.label ?? 'Cảnh báo VNDMS'),
    warning_type: warningType,
    warning_level: warningLevel,
    severity,
    value: String(row.value ?? (row.metadata as Data | undefined)?.value ?? `${severity.toUpperCase()} · cấp ${warningLevel}`),
    popupInfo: [description, district, observedAt ? `Quan sát: ${observedAt}` : ''].filter(Boolean).join(' · '),
    source: 'vndms',
    is_active: row.is_active !== false && row.status !== 'expired',
    observed_at: observedAt,
    expires_at: (String(row.expires_at ?? '') || null),
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
  };
}

export interface NormalizedIngestRecord {
  hazard: Data;
  rejected?: never;
}

export interface RejectedIngestRecord {
  index: number;
  reason: string;
  hazard_id?: string;
}

export interface NormalizedIngestBatch {
  accepted: NormalizedIngestRecord[];
  rejected: RejectedIngestRecord[];
}

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const EVENT_TYPES = new Set(['flood', 'storm', 'landslide', 'fire', 'earthquake', 'outage', 'pollution', 'drought', 'traffic', 'epidemic', 'other']);

function ingestPoint(record: Data): { lon: number; lat: number } | null {
  const geometry = record.geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (geometry && geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const lon = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lon, lat };
  }
  const lat = Number(record.lat);
  const lon = Number(record.lon ?? record.lng);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lon, lat };
  return null;
}

/**
 * Validate and normalise a VNDMS feed batch. The mapping from a VNDMS record to
 * the stored SOS hazard is deterministic so a fixture produces stable output.
 */
export function normalizeIngestBatch(input: unknown, at = new Date().toISOString()): NormalizedIngestBatch {
  const records = Array.isArray(input) ? input : (input && typeof input === 'object' ? (input as Data).records : null);
  if (!Array.isArray(records)) throw badRequest('records_required', 'records must be an array');
  if (records.length > 2000) throw badRequest('too_many_records', 'a batch may contain at most 2000 records');

  const accepted: NormalizedIngestRecord[] = [];
  const rejected: RejectedIngestRecord[] = [];

  records.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push({ index, reason: 'record_must_be_an_object' });
      return;
    }
    const record = raw as Data;
    const hazardId = String(record.hazard_id ?? record.id ?? '').trim();
    if (!hazardId) {
      rejected.push({ index, reason: 'hazard_id_required' });
      return;
    }
    const title = String(record.title ?? record.label ?? '').trim();
    if (!title) {
      rejected.push({ index, reason: 'title_required', hazard_id: hazardId });
      return;
    }
    const point = ingestPoint(record);
    if (!point) {
      rejected.push({ index, reason: 'point_geometry_required', hazard_id: hazardId });
      return;
    }
    const rawEventType = String(record.event_type ?? '').toLowerCase();
    const warningType = warningTypeOf(record);
    const eventType = EVENT_TYPES.has(rawEventType) ? rawEventType : (warningType === 'warning_flood' ? 'flood' : warningType === 'warning_wind' ? 'storm' : warningType === 'warning_earthquake' ? 'earthquake' : 'flood');
    const rawSeverity = String(record.severity ?? '').toLowerCase();
    const severity = SEVERITIES.has(rawSeverity) ? rawSeverity : LEVEL_TO_SEVERITY[warningLevelOf(record)] ?? 'medium';
    const observedAt = String(record.observed_at ?? record.issued_at ?? at);
    const expiresAt = record.expires_at ? String(record.expires_at) : null;

    accepted.push({
      hazard: {
        id: hazardId,
        hazard_id: hazardId,
        title,
        description: String(record.description ?? ''),
        event_type: eventType,
        severity,
        source: 'vndms',
        is_active: record.is_active === false ? false : true,
        status: record.is_active === false ? 'expired' : 'active',
        warning_type: warningType,
        warning_level: warningLevelOf(record),
        value: String(record.value ?? ''),
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        lat: point.lat,
        lon: point.lon,
        district: String(record.district ?? ''),
        ward: String(record.ward ?? ''),
        observed_at: observedAt,
        ingested_at: at,
        expires_at: expiresAt,
        metadata: {
          source: 'vndms',
          feed_version: record.feed_version ?? null,
          source_ref: record.source_ref ?? null,
        },
      },
    });
  });

  return { accepted, rejected };
}

export interface IngestRun {
  id: string;
  source: 'vndms';
  started_at: string;
  finished_at: string;
  status: 'succeeded' | 'partial' | 'failed';
  records_received: number;
  records_ingested: number;
  records_rejected: number;
  error: string | null;
  feed_version: string | null;
}

export interface IngestStatus {
  status: 'unconfigured' | 'ready' | 'degraded' | 'stale' | 'error';
  configured: boolean;
  source: 'vndms';
  last_run_at: string | null;
  last_success_at: string | null;
  records_ingested: number;
  records_rejected: number;
  error: string | null;
  stale: boolean;
  feed_version: string | null;
  checked_at: string;
  stale_after_minutes: number;
  connector?: IngestConnectorStatus | null;
}

/**
 * Tier-2 scheduled connector projection. SOS never schedules ingestion itself;
 * it reads the Tier-2 jobs API to report whether the connector exists, is
 * enabled and when it last ran successfully.
 */
export interface IngestConnectorStatus {
  source: 'tier-2-scheduled-job';
  available: boolean;
  configured: boolean;
  job_id: string | null;
  job_name: string | null;
  job_kind: string | null;
  enabled: boolean | null;
  schedule: { cron: string | null; every_seconds: number | null } | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_success_at: string | null;
  runs_considered: number;
  error: string | null;
  checked_at: string;
}

const CONNECTOR_DATASET = 'sos-hazard-layers';

/** Identify the VNDMS ingestion job in the Tier-2 scheduled-job list. */
export function isVndmsConnectorJob(job: Data): boolean {
  const payload = (job.payload as Data | undefined) ?? {};
  const marker = [job.id, job.name, job.kind, job.datasetId, payload.source, payload.connector, payload.feed, payload.target]
    .map((value) => String(value ?? '').toLowerCase())
    .join(' ');
  if (marker.includes('vndms')) return true;
  return String(job.datasetId ?? '') === CONNECTOR_DATASET && /ingest|hazard/.test(marker);
}

export function connectorUnavailable(error: unknown, checkedAt = new Date().toISOString()): IngestConnectorStatus {
  const status = (error as { status?: number } | undefined)?.status;
  const code = (error as { code?: string } | undefined)?.code;
  return {
    source: 'tier-2-scheduled-job',
    available: false,
    configured: false,
    job_id: null,
    job_name: null,
    job_kind: null,
    enabled: null,
    schedule: null,
    last_run_at: null,
    last_run_status: null,
    last_run_error: null,
    last_success_at: null,
    runs_considered: 0,
    error: status === 401 || status === 403
      ? 'tier2_jobs_forbidden'
      : status === 404
        ? 'tier2_jobs_unavailable'
        : code === 'capability_unavailable'
          ? 'tier2_jobs_unavailable'
          : 'tier2_jobs_unreachable',
    checked_at: checkedAt,
  };
}

export function connectorNotConfigured(checkedAt = new Date().toISOString()): IngestConnectorStatus {
  return {
    source: 'tier-2-scheduled-job',
    available: true,
    configured: false,
    job_id: null,
    job_name: null,
    job_kind: null,
    enabled: null,
    schedule: null,
    last_run_at: null,
    last_run_status: null,
    last_run_error: null,
    last_success_at: null,
    runs_considered: 0,
    error: null,
    checked_at: checkedAt,
  };
}

const RUN_SUCCEEDED = new Set(['success', 'succeeded', 'completed', 'complete', 'ok']);
const RUN_FAILED = new Set(['failed', 'error', 'crashed', 'timeout', 'timed_out']);

function runStamp(run: Data): number {
  return Date.parse(String(run.finishedAt ?? run.finished_at ?? run.startedAt ?? run.started_at ?? '')) || 0;
}

/** Project a Tier-2 job plus its run history into a connector status. */
export function connectorStatusFromRuns(
  job: Data,
  runs: Data[],
  nowMs = Date.now(),
): IngestConnectorStatus {
  const ordered = [...runs].sort((a, b) => runStamp(b) - runStamp(a));
  const last = ordered[0] ?? null;
  const success = ordered.find((run) => RUN_SUCCEEDED.has(String(run.status ?? '').toLowerCase())
    && String(run.lastError ?? run.last_error ?? '') === '');
  const schedule = (job.schedule as Data | undefined) ?? {};
  const enabled = job.enabled === undefined ? null : job.enabled !== false;
  const lastStatus = last ? String(last.status ?? 'unknown').toLowerCase() : null;
  const lastError = last ? String(last.lastError ?? last.last_error ?? '') || null : null;
  let error: string | null = null;
  if (enabled === false) error = 'connector_disabled';
  else if (lastStatus && RUN_FAILED.has(lastStatus)) error = lastError || 'connector_run_failed';
  return {
    source: 'tier-2-scheduled-job',
    available: true,
    configured: true,
    job_id: job.id ? String(job.id) : null,
    job_name: job.name ? String(job.name) : null,
    job_kind: job.kind ? String(job.kind) : null,
    enabled,
    schedule: {
      cron: schedule.cron ? String(schedule.cron) : null,
      every_seconds: Number.isFinite(Number(schedule.everySeconds)) ? Number(schedule.everySeconds) : null,
    },
    last_run_at: last ? String(last.finishedAt ?? last.finished_at ?? last.startedAt ?? last.started_at ?? '') || null : null,
    last_run_status: lastStatus,
    last_run_error: lastError,
    last_success_at: success
      ? String(success.finishedAt ?? success.finished_at ?? success.startedAt ?? success.started_at ?? '') || null
      : null,
    runs_considered: ordered.length,
    error,
    checked_at: new Date(nowMs).toISOString(),
  };
}

export function ingestStaleMinutes(value: unknown = process.env.VNDMS_STALE_MINUTES): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60;
  return Math.min(Math.max(parsed, 5), 24 * 60);
}

/**
 * Derive the public ingest status from persisted push-run state and, when
 * available, the Tier-2 scheduled connector. A never-run feed is
 * `unconfigured`, never a fake `ready`.
 */
export function ingestStatusFromRun(
  run: Data | null | undefined,
  nowMs = Date.now(),
  connector: IngestConnectorStatus | null = null,
): IngestStatus {
  const staleAfter = ingestStaleMinutes();
  const checkedAt = new Date(nowMs).toISOString();
  const connectorConfigured = connector?.configured === true;
  if (!run && !connectorConfigured) {
    return {
      status: 'unconfigured',
      configured: false,
      source: 'vndms',
      last_run_at: null,
      last_success_at: null,
      records_ingested: 0,
      records_rejected: 0,
      error: connector?.error ?? null,
      stale: true,
      feed_version: null,
      checked_at: checkedAt,
      stale_after_minutes: staleAfter,
      connector: connector ?? null,
    };
  }
  const lastRunAt = run ? String(run.finished_at ?? run.created_at ?? '') || null : null;
  const pushSuccessAt = run ? String(run.last_success_at ?? (run.status === 'succeeded' ? lastRunAt : '') ?? '') || null : null;
  const connectorSuccessAt = connector?.last_success_at ?? null;
  const successCandidates = [pushSuccessAt, connectorSuccessAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((a, b) => b.ms - a.ms);
  const lastSuccessAt = successCandidates[0]?.value ?? null;
  const successMs = successCandidates[0]?.ms;
  const stale = !Number.isFinite(successMs) || nowMs - (successMs as number) > staleAfter * 60 * 1000;
  const runStatus = String(run?.status ?? '');
  const connectorError = connector?.error ?? null;
  let status: IngestStatus['status'];
  if (runStatus === 'failed' || (run?.error && !lastSuccessAt)) status = 'error';
  else if (connectorError && !lastSuccessAt) status = 'error';
  else if (stale) status = 'stale';
  else if (runStatus === 'partial' || run?.error || connectorError) status = 'degraded';
  else status = 'ready';
  return {
    status,
    configured: true,
    source: 'vndms',
    last_run_at: lastRunAt ?? connector?.last_run_at ?? null,
    last_success_at: lastSuccessAt,
    records_ingested: Number(run?.records_ingested) || 0,
    records_rejected: Number(run?.records_rejected) || 0,
    error: run?.error ? String(run.error) : connectorError,
    stale,
    feed_version: run?.feed_version ? String(run.feed_version) : null,
    checked_at: checkedAt,
    stale_after_minutes: staleAfter,
    connector: connector ?? null,
  };
}
