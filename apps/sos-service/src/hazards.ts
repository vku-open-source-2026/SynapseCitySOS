// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Hazard helpers: stale-feed expiry and the SSE frame format.
 */
export type HazardData = Record<string, unknown>;

export const DEFAULT_HAZARD_TTL_HOURS = 24;
export const MAX_HAZARD_TTL_HOURS = 24 * 30;

export function hazardTtlHours(value: unknown): number {
  const hours = Number(value ?? process.env.HAZARD_TTL_HOURS ?? DEFAULT_HAZARD_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_HAZARD_TTL_HOURS;
  return Math.min(hours, MAX_HAZARD_TTL_HOURS);
}

function timestampOf(value: unknown): number | null {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

/** Most recent meaningful hazard timestamp, in ms since epoch. */
export function hazardTimestamp(hazard: HazardData): number | null {
  for (const key of ['observed_at', 'created_at', 'updated_at', 'detected_at', 'last_seen_at']) {
    const timestamp = timestampOf(hazard[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

/** A hazard is stale when it is active and older than the TTL. */
export function isHazardStale(hazard: HazardData, nowMs: number, ttlHours = DEFAULT_HAZARD_TTL_HOURS): boolean {
  if (hazard.is_active === false || hazard.status === 'expired') return false;
  const timestamp = hazardTimestamp(hazard);
  if (timestamp === null) return false;
  return nowMs - timestamp > hazardTtlHours(ttlHours) * 60 * 60 * 1000;
}

/** Wire format for one SSE frame. Real LF bytes, never an escaped `\\n`. */
export function sseHazardsFrame(payload: unknown): string {
  return `event: hazards\ndata: ${JSON.stringify(payload)}\n\n`;
}
