// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignmentResourceUnitId,
  normalizeDispatchAssignment,
  requestedResourceUnitId,
} from './dispatch';

test('assignmentResourceUnitId prefers the canonical field', () => {
  assert.equal(
    assignmentResourceUnitId({
      assigned_resource_unit_id: 'r1',
      assigned_user_id: 'legacy',
      assignments: [{ resource_unit_id: 'assignment' }],
    }),
    'r1',
  );
});

test('assignmentResourceUnitId falls back to legacy orders and assignments', () => {
  assert.equal(assignmentResourceUnitId({ assigned_user_id: 'r2' }), 'r2');
  assert.equal(assignmentResourceUnitId({ assignments: [{ resource_unit_id: 'r3' }] }), 'r3');
  assert.equal(assignmentResourceUnitId({ assignments: [{ assigned_user_id: 'r4' }] }), 'r4');
  assert.equal(assignmentResourceUnitId({}), null);
});

test('requestedResourceUnitId accepts every inbound alias', () => {
  assert.equal(requestedResourceUnitId({ assigned_resource_unit_id: 'a' }), 'a');
  assert.equal(requestedResourceUnitId({ resource_unit_id: 'b' }), 'b');
  assert.equal(requestedResourceUnitId({ assigned_user_id: 'c' }), 'c');
  assert.equal(requestedResourceUnitId({ user_id: 'd' }), 'd');
  assert.equal(requestedResourceUnitId({}), null);
});

test('approval writes canonical and legacy fields plus an assignment row', () => {
  const patch = normalizeDispatchAssignment(
    { assigned_resource_unit_id: 'r1', notes: 'go' },
    [],
    { now: '2026-11-03T00:00:00.000Z' },
  );
  assert.equal(patch.status, 'assigned');
  assert.equal(patch.assigned_resource_unit_id, 'r1');
  assert.equal(patch.assigned_user_id, 'r1');
  const assignments = patch.assignments as Array<Record<string, unknown>>;
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].resource_unit_id, 'r1');
  assert.equal(assignments[0].assigned_resource_unit_id, 'r1');
  assert.equal(assignments[0].assigned_user_id, 'r1');
  assert.equal(assignments[0].notes, 'go');
  assert.equal(assignments[0].assigned_at, '2026-11-03T00:00:00.000Z');
});

test('approval accepts the legacy user_id alias and does not duplicate rows', () => {
  const patch = normalizeDispatchAssignment(
    { user_id: 'r2', notes: 'legacy' },
    [{ resource_unit_id: 'old' }],
    { now: '2026-11-03T00:00:00.000Z' },
  );
  assert.equal(patch.assigned_resource_unit_id, 'r2');
  assert.equal(patch.assigned_user_id, 'r2');
  const assignments = patch.assignments as Array<Record<string, unknown>>;
  assert.equal(assignments.length, 2);
  assert.ok(assignments.some((item) => item.resource_unit_id === 'old'));
});

test('an approval without an id still updates status without inventing an assignee', () => {
  const patch = normalizeDispatchAssignment({ notes: 'no id' }, [], { status: 'assigned' });
  assert.equal(patch.status, 'assigned');
  assert.equal(patch.assigned_resource_unit_id, undefined);
  assert.equal(patch.assigned_user_id, undefined);
  assert.equal(patch.assignments, undefined);
});
