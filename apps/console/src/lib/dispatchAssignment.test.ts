// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import { resolveAssignedResourceUnitId } from './dispatchAssignment';
import type { DispatchOrder } from '../types/dispatch';

function order(partial: Partial<DispatchOrder>): DispatchOrder {
  return {
    id: 'd1',
    emergency_event_id: 'e1',
    task_title: 'Task',
    priority: 'high',
    status: 'assigned',
    assignments: [],
    metadata: {},
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    ...partial,
  };
}

describe('resolveAssignedResourceUnitId', () => {
  it('prefers the canonical assigned_resource_unit_id', () => {
    expect(resolveAssignedResourceUnitId(order({
      assigned_resource_unit_id: 'r1',
      assigned_user_id: 'legacy',
      assignments: [{ resource_unit_id: 'assignment' }],
    }))).toBe('r1');
  });

  it('falls back to the legacy assigned_user_id mirror', () => {
    expect(resolveAssignedResourceUnitId(order({ assigned_user_id: 'r2' }))).toBe('r2');
  });

  it('reads assignments[].resource_unit_id when the order field is missing', () => {
    expect(resolveAssignedResourceUnitId(order({
      assignments: [{ resource_unit_id: 'r3' }],
    }))).toBe('r3');
  });

  it('reads legacy assignment aliases and ignores blank values', () => {
    expect(resolveAssignedResourceUnitId(order({
      assigned_resource_unit_id: '   ',
      assignments: [{ assigned_user_id: 'r4' }],
    }))).toBe('r4');
  });

  it('returns null when nothing is assigned', () => {
    expect(resolveAssignedResourceUnitId(order({}))).toBeNull();
    expect(resolveAssignedResourceUnitId(null)).toBeNull();
  });
});
