// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Read-through projection of the Tier-2 KTTV hazard feed.
 *
 * SynapseCitySOS does not crawl NCHMF/VNDMS and does not persist a second copy
 * of the hazard catalogue. The Tier-2 capabilities API owns ingestion and
 * normalisation; this module only converts the Tier-2 wire shape into the SOS
 * hazard projection. A short process-local cache (30 s) protects Tier-2 from
 * a burst of anonymous map requests; it is never a system of record.
 */
import type { CapabilitiesClient } from '@synapsedx/capabilities';
import type { Data } from './filters';

export interface Tier2HazardFeedStatus {
  status?: string;
  configured?: boolean;
  source?: string;
  last_run_at?: string | null;
  last_success_at?: string | null;
  running?: boolean;
  hazards?: number;
  indexed?: number;
  error?: string | null;
}

const FEED_TTL_MS = Math.min(Math.max(Number(process.env.SOS_TIER2_HAZARD_TTL_MS) || 30_000, 1_000), 5 * 60_000);
const STATUS_TTL_MS = Math.min(Math.max(Number(process.env.SOS_TIER2_STATUS_TTL_MS) || 30_000, 1_000), 5 * 60_000);

interface CacheEntry<T> { at: number; value: T }
const feedCache = new Map<number, CacheEntry<Data[]>>();
let statusCache: CacheEntry<Tier2HazardFeedStatus | null> | null = null;

function tier2Client(client: CapabilitiesClient): {
  today?: (query: { hours: number; limit: number }) => Promise<{ hazards?: unknown[] }>;
  status?: () => Promise<Tier2HazardFeedStatus>;
} | null {
  const sdk = client as unknown as {
    hazards?: {
      today?: (query: { hours: number; limit: number }) => Promise<{ hazards?: unknown[] }>;
      status?: () => Promise<Tier2HazardFeedStatus>;
    };
  };
  return sdk.hazards ?? null;
}

function isoOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function pointGeometry(geometry: unknown): { type: 'Point'; coordinates: [number, number] } | null {
  const candidate = geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (!candidate || candidate.type !== 'Point' || !Array.isArray(candidate.coordinates) || candidate.coordinates.length < 2) return null;
  const lon = Number(candidate.coordinates[0]);
  const lat = Number(candidate.coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { type: 'Point', coordinates: [lon, lat] };
}

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const EVENT_TYPES = new Set([
  'flood', 'storm', 'rain', 'landslide', 'fire', 'earthquake', 'outage',
  'pollution', 'drought', 'traffic', 'epidemic', 'heat', 'cold', 'other',
]);

/** Convert a Tier-2 hazard record into the SOS public hazard projection. */
export function toSosHazard(record: unknown): Data | null {
  if (!record || typeof record !== 'object') return null;
  const row = record as Record<string, unknown>;
  const hazardId = String(row.hazard_id ?? row.id ?? '').trim();
  if (!hazardId) return null;
  const publishedAt = isoOrNull(row.published_at) || isoOrNull(row.fetched_at) || new Date().toISOString();
  const fetchedAt = isoOrNull(row.fetched_at) || publishedAt;
  const source = String(row.source ?? '').toLowerCase() === 'vndms' ? 'vndms' : 'nchmf';
  const provinces = Array.isArray(row.provinces) ? row.provinces.map(String).filter(Boolean).slice(0, 24) : [];
  const eventType = String(row.event_type ?? 'other');
  const severity = String(row.severity ?? 'medium');
  const geometry = pointGeometry(row.geometry) ?? { type: 'Point' as const, coordinates: [105.8542, 21.0285] as [number, number] };
  return {
    id: `synapsedx-${String(row.id ?? hazardId).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 160)}`,
    hazard_id: hazardId,
    title: String(row.title ?? 'Cảnh báo khí tượng thủy văn').slice(0, 300),
    description: String(row.description ?? '').slice(0, 4000),
    event_type: EVENT_TYPES.has(eventType) ? eventType : 'other',
    severity: SEVERITIES.has(severity) ? severity : 'medium',
    source,
    status: 'active',
    is_active: row.is_active !== false,
    geometry,
    provinces,
    district: provinces[0] ?? null,
    url: typeof row.url === 'string' ? row.url : null,
    published_at: publishedAt,
    observed_at: publishedAt,
    detected_at: fetchedAt,
    last_seen_at: fetchedAt,
    created_at: publishedAt,
    updated_at: fetchedAt,
    metadata: {
      tier2: true,
      feed: 'kttv',
      source,
      provinces,
      url: typeof row.url === 'string' ? row.url : null,
      published_at: publishedAt,
      fetched_at: fetchedAt,
    },
    linked_event_id: null,
    linked_eop_plan_id: null,
  };
}

/** Feed records win over a stored copy with the same stable hazard_id. */
export function mergeHazardFeed(stored: Data[], feed: Data[]): Data[] {
  const merged = new Map<string, Data>();
  for (const row of stored) merged.set(String(row.hazard_id ?? row.id), row);
  for (const row of feed) merged.set(String(row.hazard_id ?? row.id), row);
  return [...merged.values()];
}

/** Today's Tier-2 hazards with a short read-through cache. */
export async function fetchTier2Hazards(
  client: CapabilitiesClient,
  hours = 72,
  limit = 200,
  nowMs = Date.now(),
): Promise<Data[]> {
  const sdk = tier2Client(client);
  if (!sdk?.today) return [];
  const boundedHours = Math.min(Math.max(Math.trunc(hours) || 72, 1), 168);
  const cached = feedCache.get(boundedHours);
  if (cached && nowMs - cached.at < FEED_TTL_MS) return cached.value;
  try {
    const feed = await sdk.today({ hours: boundedHours, limit: Math.min(Math.max(Math.trunc(limit) || 200, 1), 500) });
    const items = (Array.isArray(feed?.hazards) ? feed.hazards : [])
      .map(toSosHazard)
      .filter((row): row is Data => row !== null);
    feedCache.set(boundedHours, { at: nowMs, value: items });
    return items;
  } catch {
    // Serve the last good snapshot when Tier-2 is briefly unavailable. This is
    // a read cache, not a fallback data store; an empty first call stays empty.
    return cached?.value ?? [];
  }
}

/** Tier-2 crawler status (last run, counts, source health) with a short cache. */
export async function fetchTier2HazardStatus(
  client: CapabilitiesClient,
  nowMs = Date.now(),
): Promise<Tier2HazardFeedStatus | null> {
  const sdk = tier2Client(client);
  if (!sdk?.status) return null;
  if (statusCache && nowMs - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  try {
    const status = await sdk.status();
    statusCache = { at: nowMs, value: status };
    return status;
  } catch {
    return statusCache?.value ?? null;
  }
}
