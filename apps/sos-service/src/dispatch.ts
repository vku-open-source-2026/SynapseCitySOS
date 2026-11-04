// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dispatch assignment normalization.
 *
 * SOS responder assignment is always an SOS resource-unit id. The canonical
 * wire/storage field is `assigned_resource_unit_id`; `assigned_user_id` is kept
 * as a legacy mirror for older clients and `user_id` / `resource_unit_id` are
 * accepted only as inbound aliases.
 */
export type DispatchData = Record<string, unknown>;

export interface DispatchAssignmentRecord {
  resource_unit_id?: string | null;
  assigned_resource_unit_id?: string | null;
  assigned_user_id?: string | null;
  notes?: string | null;
  assigned_at?: string;
  [key: string]: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** First non-empty resource-unit id from a dispatch order or assignment. */
export function assignmentResourceUnitId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as DispatchData;
  const direct = nonEmptyString(record.assigned_resource_unit_id)
    ?? nonEmptyString(record.resource_unit_id)
    ?? nonEmptyString(record.assigned_user_id)
    ?? nonEmptyString(record.user_id);
  if (direct) return direct;
  const assignments = Array.isArray(record.assignments) ? record.assignments : [];
  for (const assignment of assignments) {
    const id = assignmentResourceUnitId(assignment);
    if (id) return id;
  }
  return null;
}

/** Resolve the resource-unit id from an inbound approval body. */
export function requestedResourceUnitId(input: DispatchData): string | null {
  return nonEmptyString(input.assigned_resource_unit_id)
    ?? nonEmptyString(input.resource_unit_id)
    ?? nonEmptyString(input.assigned_user_id)
    ?? nonEmptyString(input.user_id);
}

/**
 * Build the patch for `POST /v1/emergency/dispatch/:id/{approve,assign}`.
 * The same opaque SOS resource-unit id is stored in every assignment field so
 * old and new console builds both read a value.
 *
 * Crucially, the status is only advanced to `assigned` when an actual resource
 * unit id is present. An approval without an assignee must be rejected by the
 * route (400 `assigned_resource_unit_id_required`), never persisted as an
 * unassigned "assigned" order (issue #20).
 */
export function normalizeDispatchAssignment(
  input: DispatchData,
  currentAssignments: unknown,
  options: { status?: string; now?: string } = {},
): DispatchData {
  const {
    assigned_resource_unit_id: _assignedResourceUnitId,
    resource_unit_id: _resourceUnitId,
    assigned_user_id: _assignedUserId,
    user_id: _userId,
    if_version: _ifVersion,
    ifVersion: _ifVersionCamel,
    ...rest
  } = input;
  const patch: DispatchData = { ...rest };
  const resourceUnitId = requestedResourceUnitId(input);
  if (!resourceUnitId) return patch;
  patch.status = options.status ?? 'assigned';

  const timestamp = options.now ?? new Date().toISOString();
  const existing = Array.isArray(currentAssignments)
    ? currentAssignments.filter((item): item is DispatchAssignmentRecord => Boolean(item) && typeof item === 'object')
    : [];
  const remaining = existing.filter((assignment) => assignmentResourceUnitId(assignment) !== resourceUnitId);
  const notes = nonEmptyString(input.notes);

  patch.assigned_resource_unit_id = resourceUnitId;
  patch.assigned_user_id = resourceUnitId;
  patch.assignments = [
    ...remaining,
    {
      resource_unit_id: resourceUnitId,
      assigned_resource_unit_id: resourceUnitId,
      assigned_user_id: resourceUnitId,
      notes: notes ?? null,
      assigned_at: timestamp,
    },
  ];
  return patch;
}
