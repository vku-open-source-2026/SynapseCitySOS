// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SITREP validation and lifecycle rules.
 *
 * A SITREP is an operational report, not arbitrary JSON:
 * - it must reference a real emergency event;
 * - it needs a title, an author, a source and a reporting period;
 * - casualty/damage counters are non-negative integers;
 * - the lifecycle is draft → review_pending → published;
 * - a published report is immutable. A delta against a published report creates
 *   a new revision with `amends_sitrep_id` instead of mutating history.
 */
import { badRequest, conflict } from './errors';
import type { Data } from './filters';

export type SitrepStatus = 'draft' | 'review_pending' | 'published' | 'archived';
const STATUSES = new Set<SitrepStatus>(['draft', 'review_pending', 'published', 'archived']);
const IMMUTABLE: SitrepStatus[] = ['published', 'archived'];

const COUNT_FIELDS = [
  'casualties',
  'deaths',
  'injuries',
  'missing',
  'affected_people',
  'evacuated_people',
  'damaged_structures',
  'destroyed_structures',
  'rescued_people',
  'resources_deployed',
];

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  value: Data;
  errors: FieldError[];
}

function isIsoDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateCounts(source: Data, prefix: string, errors: FieldError[]): void {
  for (const field of COUNT_FIELDS) {
    const value = source[field];
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      errors.push({ field: `${prefix}${field}`, code: 'non_negative_integer_required', message: `${field} must be a non-negative integer` });
    }
  }
  const numbers = source.numbers;
  if (numbers !== undefined) {
    if (!numbers || typeof numbers !== 'object' || Array.isArray(numbers)) {
      errors.push({ field: `${prefix}numbers`, code: 'object_required', message: 'numbers must be an object' });
    } else {
      validateCounts(numbers as Data, `${prefix}numbers.`, errors);
    }
  }
}

function normaliseCounts(source: Data): Data {
  const output: Data = { ...source };
  for (const field of COUNT_FIELDS) {
    if (output[field] !== undefined && output[field] !== null && output[field] !== '') output[field] = Number(output[field]);
  }
  if (output.numbers && typeof output.numbers === 'object' && !Array.isArray(output.numbers)) {
    const numbers: Data = { ...(output.numbers as Data) };
    for (const field of COUNT_FIELDS) {
      if (numbers[field] !== undefined && numbers[field] !== null && numbers[field] !== '') numbers[field] = Number(numbers[field]);
    }
    output.numbers = numbers;
  }
  return output;
}

export interface SitrepActor {
  username?: string;
  id?: string;
}

/** Validate a SITREP create payload. `eventExists` is checked by the route. */
export function validateSitrepCreate(input: Data, actor: SitrepActor = {}): ValidationResult {
  const errors: FieldError[] = [];
  const value: Data = { ...input };

  const eventId = typeof value.emergency_event_id === 'string' ? value.emergency_event_id.trim() : '';
  if (!eventId) errors.push({ field: 'emergency_event_id', code: 'required', message: 'emergency_event_id is required' });

  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!title) errors.push({ field: 'title', code: 'required', message: 'title is required' });
  value.title = title;

  const periodStart = value.reporting_period_start ?? (value.reporting_period as Data | undefined)?.start;
  const periodEnd = value.reporting_period_end ?? (value.reporting_period as Data | undefined)?.end;
  if (!isIsoDate(periodStart)) errors.push({ field: 'reporting_period_start', code: 'iso_date_required', message: 'reporting_period_start must be an ISO timestamp' });
  if (!isIsoDate(periodEnd)) errors.push({ field: 'reporting_period_end', code: 'iso_date_required', message: 'reporting_period_end must be an ISO timestamp' });
  if (isIsoDate(periodStart) && isIsoDate(periodEnd) && Date.parse(String(periodEnd)) < Date.parse(String(periodStart))) {
    errors.push({ field: 'reporting_period_end', code: 'before_start', message: 'reporting_period_end must not precede reporting_period_start' });
  }
  value.reporting_period_start = isIsoDate(periodStart) ? new Date(String(periodStart)).toISOString() : null;
  value.reporting_period_end = isIsoDate(periodEnd) ? new Date(String(periodEnd)).toISOString() : null;

  value.author = typeof value.author === 'string' && value.author.trim()
    ? value.author.trim()
    : (actor.username || 'sos-operator');
  value.source = typeof value.source === 'string' && value.source.trim() ? value.source.trim() : 'sos-console';

  const status = value.status === undefined ? 'draft' : String(value.status);
  if (!STATUSES.has(status as SitrepStatus)) errors.push({ field: 'status', code: 'invalid_status', message: 'status must be draft, review_pending, published or archived' });
  if (status === 'published' || status === 'archived') {
    errors.push({ field: 'status', code: 'publish_requires_review', message: 'create a draft and publish it through /publish' });
  }
  value.status = status === 'review_pending' ? 'review_pending' : 'draft';

  validateCounts(value, '', errors);

  return { value: normaliseCounts(value), errors };
}

export function validateSitrepUpdate(input: Data, current: Data): ValidationResult {
  const errors: FieldError[] = [];
  const currentStatus = String(current.status ?? 'draft') as SitrepStatus;
  if (IMMUTABLE.includes(currentStatus)) {
    throw conflict('sitrep_published_immutable', 'a published or archived SITREP cannot be mutated; create a delta revision instead');
  }
  const value: Data = { ...input };
  if (value.title !== undefined) {
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    if (!title) errors.push({ field: 'title', code: 'required', message: 'title must not be empty' });
    value.title = title;
  }
  if (value.status !== undefined) {
    const next = String(value.status) as SitrepStatus;
    if (!STATUSES.has(next)) errors.push({ field: 'status', code: 'invalid_status', message: 'invalid SITREP status' });
    const order: SitrepStatus[] = ['draft', 'review_pending', 'published', 'archived'];
    if (order.indexOf(next) < order.indexOf(currentStatus)) {
      throw conflict('invalid_status_transition', `cannot move SITREP from ${currentStatus} to ${next}`);
    }
    if (next === 'published' || next === 'archived') {
      errors.push({ field: 'status', code: 'publish_requires_review', message: 'use /publish to publish a SITREP' });
    }
  }
  validateCounts(value, '', errors);
  return { value: normaliseCounts(value), errors };
}

/** A published report cannot be published again without a review cycle. */
export function assertPublishable(current: Data): void {
  const status = String(current.status ?? 'draft');
  if (status === 'published' || status === 'archived') {
    throw conflict('sitrep_already_published', 'this SITREP is already published; create a delta revision');
  }
  const hasContent = Boolean(
    (current.snapshot && typeof current.snapshot === 'object' && Object.keys(current.snapshot as Data).length > 0)
    || (current.summary && String(current.summary).trim())
    || (current.reporting_period_start && current.reporting_period_end),
  );
  if (!hasContent) {
    throw badRequest('sitrep_content_required', 'a SITREP needs a snapshot, summary or reporting period before publishing');
  }
  if (status !== 'review_pending') {
    throw conflict('sitrep_review_required', `move the SITREP to review_pending before publishing (current: ${status})`);
  }
}

/** Build a new draft revision that amends a published SITREP. */
export function revisionFromDelta(current: Data, delta: Data, actor: SitrepActor, now = new Date().toISOString()): Data {
  const id = `sitrep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...current,
    id,
    status: 'draft',
    amends_sitrep_id: current.id,
    version: (Number(current.version) || 1) + 1,
    deltas: [{ ...delta, actor_id: actor.id ?? actor.username ?? null, created_at: now }],
    published_at: null,
    published_by: null,
    created_at: now,
    updated_at: now,
    author: actor.username ?? current.author ?? 'sos-operator',
  };
}
