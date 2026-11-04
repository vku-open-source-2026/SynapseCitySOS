// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Query filtering and pagination helpers.
 *
 * Tier-2 currently exposes only `limit`/`offset` on `records.list` (no field
 * predicates, see SynapseDX #5/#13). SOS therefore pages the dataset first and
 * filters in memory. That is explicitly documented as a lower-tier dependency:
 * when Tier 2 grows server-side predicates, `listAll` can be replaced without
 * changing the route contract.
 *
 * The important correctness rule is that supported query keys are interpreted
 * with their real types. A previous generic `String(row[key])` matcher compared
 * `active_only` against a non-existent record field, so `active_only=true`
 * always returned an empty list (issue #11).
 */
export type Data = Record<string, unknown>;

export const MAX_SCAN_RECORDS = Number(process.env.SOS_MAX_SCAN_RECORDS || 5000);
export const SCAN_PAGE_SIZE = 500;

export interface PageLike<T> {
  items: Array<{ id: string; data: T }>;
  total?: number;
  limit?: number;
  offset?: number;
}

/** Parse a boolean query value; `undefined` means "not supplied". */
export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/** Parse a finite number query value, clamped to [min, max]. */
export function parseNumber(value: unknown, options: { min?: number; max?: number; fallback?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === '') return options.fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return options.fallback;
  let result = parsed;
  if (options.min !== undefined) result = Math.max(options.min, result);
  if (options.max !== undefined) result = Math.min(options.max, result);
  return result;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function timestampOf(value: unknown): number | null {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

const TIME_FIELDS = ['observed_at', 'detected_at', 'issued_at', 'created_at', 'updated_at', 'started_at', 'last_seen_at'];

export function recordTimestamp(row: Data): number | null {
  for (const field of TIME_FIELDS) {
    const parsed = timestampOf(row[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

const PAGING_KEYS = new Set(['limit', 'skip', 'offset', 'page', 'page_size']);
const BOOLEAN_KEYS = new Set(['active_only', 'is_active']);
const TEXT_KEYS = new Set([
  'event_type',
  'severity',
  'source',
  'district',
  'ward',
  'status',
  'event_id',
  'emergency_event_id',
  'eop_plan_id',
  'resource_type',
  'priority',
  'linked_event_id',
  'report_code',
]);

function matchesText(row: Data, key: string, expected: string): boolean {
  // `emergency_event_id` is the canonical field; accept `event_id` as an alias.
  const candidates = key === 'event_id'
    ? [row.event_id, row.emergency_event_id]
    : [row[key]];
  return candidates.some((candidate) => text(candidate)?.toLowerCase() === expected.toLowerCase());
}

/**
 * Filter rows by the supported query contract. Unknown keys are ignored on
 * purpose: a typo must never turn a list into an empty success response.
 */
export function filterRows(rows: Data[], query: Record<string, unknown>): Data[] {
  const activeOnly = parseBoolean(query.active_only);
  const isActive = parseBoolean(query.is_active);
  const hours = parseNumber(query.hours, { min: 0, max: 24 * 365 });
  const q = text(query.q)?.toLowerCase();
  const cutoff = hours !== undefined && hours > 0 ? Date.now() - hours * 60 * 60 * 1000 : null;

  return rows.filter((row) => {
    if (activeOnly !== undefined) {
      const active = row.is_active !== false && row.status !== 'expired' && row.status !== 'archived';
      if (active !== activeOnly) return false;
    }
    if (isActive !== undefined) {
      const active = row.is_active !== false && row.status !== 'expired';
      if (active !== isActive) return false;
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || PAGING_KEYS.has(key) || BOOLEAN_KEYS.has(key)) continue;
      if (key === 'hours' || key === 'q') continue;
      if (TEXT_KEYS.has(key)) {
        const expected = text(value);
        if (expected && !matchesText(row, key, expected)) return false;
      }
      // Unknown keys are ignored rather than silently filtering everything out.
    }
    if (cutoff !== null) {
      const stamp = recordTimestamp(row);
      if (stamp === null || stamp < cutoff) return false;
    }
    if (q) {
      const haystack = [row.id, row.hazard_id, row.title, row.description, row.task_title, row.report_code]
        .map(text)
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export interface Paginated<T> {
  items: T[];
  total: number;
  scanned: number;
  truncated: boolean;
}

/**
 * Read every page of a dataset up to a bounded scan budget. The result reports
 * whether the scan was truncated so callers can be honest about incomplete
 * answers instead of silently returning a partial list.
 */
export async function pageAll<T>(
  listPage: (query: { limit: number; offset: number }) => Promise<PageLike<T>>,
  options: { maxRecords?: number; pageSize?: number } = {},
): Promise<Paginated<T>> {
  const maxRecords = Math.max(1, options.maxRecords ?? MAX_SCAN_RECORDS);
  const pageSize = Math.max(1, options.pageSize ?? SCAN_PAGE_SIZE);
  const items: T[] = [];
  let offset = 0;
  let scanned = 0;
  let truncated = false;

  while (scanned < maxRecords) {
    const page = await listPage({ limit: Math.min(pageSize, maxRecords - scanned), offset });
    const batch = Array.isArray(page.items) ? page.items : [];
    for (const item of batch) {
      items.push(item.data);
      scanned += 1;
    }
    const total = Number(page.total);
    offset += batch.length;
    if (batch.length === 0) break;
    if (Number.isFinite(total) && offset >= total) break;
    if (batch.length < pageSize) break;
    if (scanned >= maxRecords) {
      truncated = Number.isFinite(total) ? offset < total : true;
      break;
    }
  }

  return { items, total: items.length, scanned, truncated };
}
