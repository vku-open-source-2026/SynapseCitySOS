// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { planOptimization, requiredCapability, resourceTypesForCapability } from './optimizer';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');

test('capability mapping covers the SOS resource types', () => {
  assert.deepEqual(resourceTypesForCapability('medical'), ['medical_supply', 'personnel']);
  assert.deepEqual(resourceTypesForCapability('shelter'), ['shelter']);
  assert.equal(requiredCapability({ metadata: { required_capability: 'vehicle' } }), 'vehicle');
  assert.equal(requiredCapability({}), 'personnel');
});

test('optimizer assigns only available compatible units and never reuses one', () => {
  const orders = [
    { id: 'o1', status: 'pending', priority: 'critical', district: 'A', required_capability: 'personnel', created_at: '2026-11-04T10:00:00.000Z' },
    { id: 'o2', status: 'pending', priority: 'high', district: 'A', required_capability: 'personnel', created_at: '2026-11-04T10:05:00.000Z' },
  ];
  const resources = [
    { id: 'r1', status: 'available', resource_type: 'personnel', district: 'A', capacity: 10 },
    { id: 'r2', status: 'offline', resource_type: 'personnel', district: 'A' },
    { id: 'r3', status: 'maintenance', resource_type: 'personnel', district: 'A' },
    { id: 'r4', status: 'available', resource_type: 'medical_supply', district: 'A' },
  ];
  const plan = planOptimization(orders, resources, { nowMs: NOW });
  assert.equal(plan.assignments.length, 1);
  assert.equal(plan.assignments[0].resource_unit_id, 'r1');
  assert.deepEqual(plan.unassignable, ['o2']);
});

test('optimizer prefers the nearest compatible unit and computes ETA', () => {
  const orders = [{ id: 'o1', status: 'pending', priority: 'high', required_capability: 'personnel', target_location: { type: 'Point', coordinates: [108, 16] }, created_at: '2026-11-04T11:00:00.000Z' }];
  const resources = [
    { id: 'far', status: 'available', resource_type: 'personnel', current_location: { type: 'Point', coordinates: [109, 17] } },
    { id: 'near', status: 'available', resource_type: 'personnel', current_location: { type: 'Point', coordinates: [108.01, 16] } },
  ];
  const plan = planOptimization(orders, resources, { nowMs: NOW });
  assert.equal(plan.assignments[0].resource_unit_id, 'near');
  assert.ok(plan.assignments[0].eta_minutes >= 1);
  assert.ok(Number(plan.assignments[0].distance_km) < 5);
});

test('optimizer flags stale unassignable orders and skips terminal orders', () => {
  const orders = [
    { id: 'stale', status: 'pending', priority: 'low', required_capability: 'shelter', created_at: '2026-11-04T08:00:00.000Z' },
    { id: 'done', status: 'completed', priority: 'low', created_at: '2026-11-04T08:00:00.000Z' },
  ];
  const plan = planOptimization(orders, [], { nowMs: NOW, staleMinutes: 120 });
  assert.deepEqual(plan.unassignable, ['stale']);
  assert.deepEqual(plan.stale, ['stale']);
  assert.deepEqual(plan.skipped_terminal, ['done']);
});

test('optimizer keeps an already assigned unit reserved', () => {
  const orders = [
    { id: 'a', status: 'assigned', assigned_resource_unit_id: 'r1', priority: 'high', created_at: '2026-11-04T10:00:00.000Z' },
    { id: 'b', status: 'pending', priority: 'high', required_capability: 'personnel', created_at: '2026-11-04T10:00:00.000Z' },
  ];
  const plan = planOptimization(orders, [{ id: 'r1', status: 'available', resource_type: 'personnel' }], { nowMs: NOW });
  assert.equal(plan.assignments.length, 0);
  assert.deepEqual(plan.used_resources, ['r1']);
  assert.deepEqual(plan.unassignable, ['b']);
});
