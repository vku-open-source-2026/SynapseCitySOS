// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Resolve the assigned SOS resource unit from a dispatch order.
 *
 * The canonical field is `assigned_resource_unit_id`; `assigned_user_id` is a
 * deprecated mirror kept for older records. Assignment rows use
 * `resource_unit_id` / `assigned_resource_unit_id`. Never treat the value as a
 * City user id.
 */
import type { DispatchOrder } from '../types/dispatch';

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveAssignedResourceUnitId(
  order: Pick<DispatchOrder, 'assigned_resource_unit_id' | 'assigned_user_id' | 'assignments'> | null | undefined,
): string | null {
  if (!order) return null;
  const direct =
    nonEmpty(order.assigned_resource_unit_id) ??
    nonEmpty(order.assigned_user_id);
  if (direct) return direct;

  const assignments = Array.isArray(order.assignments) ? order.assignments : [];
  for (const assignment of assignments) {
    const id =
      nonEmpty(assignment?.assigned_resource_unit_id) ??
      nonEmpty(assignment?.resource_unit_id) ??
      nonEmpty(assignment?.assigned_user_id);
    if (id) return id;
  }
  return null;
}
