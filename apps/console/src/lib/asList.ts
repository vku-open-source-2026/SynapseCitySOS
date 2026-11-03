// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Normalize list endpoints that may return a bare array or an envelope.
 *
 * A misconfigured edge can return the SPA `index.html` with HTTP 200; the caller
 * must receive an empty array instead of a string and never call `.filter` or
 * `.forEach` on the payload directly.
 */
export function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ["data", "items", "results"]) {
      if (Array.isArray(record[key])) {
        return record[key] as T[];
      }
    }
  }
  return [];
}

/** True when a response payload is not a list or list envelope. */
export function isNonListPayload(value: unknown): boolean {
  if (Array.isArray(value)) return false;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return !["data", "items", "results"].some((key) => Array.isArray(record[key]));
  }
  return value !== undefined && value !== null;
}
