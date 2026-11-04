// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAfterAction, responseSpeedScore, slaBreachCount } from './after-action';

const START = Date.parse('2026-11-04T08:00:00.000Z');
const iso = (offsetMinutes: number) => new Date(START + offsetMinutes * 60_000).toISOString();

test('an empty event produces zero metrics without NaN', () => {
  const computed = computeAfterAction({
    event: { id: 'e', title: 'Empty', status: 'resolved', severity: 'medium', created_at: iso(0), ended_at: iso(120), updated_at: iso(120) },
    nowMs: START + 120 * 60_000,
  });
  assert.equal(computed.kpi.dispatch_total, 0);
  assert.equal(computed.kpi.dispatch_completion_rate, 0);
  assert.equal(computed.kpi.resource_efficiency_score, 0);
  assert.ok(Number.isFinite(computed.kpi.overall_score));
  assert.ok(computed.timeline.length >= 2);
});

test('KPI values match a fixture event with known timestamps', () => {
  const computed = computeAfterAction({
    event: { id: 'e', title: 'Flood', status: 'resolved', severity: 'high', created_at: iso(0), started_at: iso(0), ended_at: iso(360), updated_at: iso(360) },
    orders: [
      { id: '1', status: 'completed', created_at: iso(10), completed_at: iso(100), assigned_resource_unit_id: 'r1', assignments: [{ assigned_at: iso(30) }] },
      { id: '2', status: 'completed', created_at: iso(15), completed_at: iso(200), assigned_resource_unit_id: 'r2', assignments: [{ assigned_at: iso(40) }] },
      { id: '3', status: 'canceled', created_at: iso(20) },
    ],
    sitreps: [
      { id: 's1', status: 'published', created_at: iso(60), published_at: iso(70) },
    ],
    resources: [
      { id: 'r1', status: 'available' },
      { id: 'r2', status: 'available' },
      { id: 'r3', status: 'offline' },
    ],
    nowMs: START + 360 * 60_000,
  });
  assert.equal(computed.kpi.response_time_minutes, 30);
  assert.equal(computed.kpi.response_sla_minutes, 60);
  assert.equal(computed.kpi.response_speed_score, 100);
  assert.equal(computed.kpi.dispatch_completion_rate, 100);
  assert.equal(computed.kpi.sitrep_coverage_rate, 100);
  assert.equal(computed.kpi.resource_efficiency_score, 100);
  assert.equal(computed.kpi.overall_score, 100);
  assert.equal(computed.kpi.dispatch_total, 3);
  assert.equal(computed.kpi.dispatch_completed, 2);
  assert.equal(computed.kpi.dispatch_canceled, 1);
  assert.equal(computed.kpi.resources_assigned, 2);
  assert.ok(computed.timeline.every((entry) => Number.isFinite(Date.parse(entry.timestamp))));
  const sorted = [...computed.timeline].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  assert.deepEqual(computed.timeline.map((entry) => entry.timestamp), sorted.map((entry) => entry.timestamp));
});

test('partial data degrades the score instead of fabricating success', () => {
  const computed = computeAfterAction({
    event: { id: 'e', title: 'Partial', status: 'active', severity: 'critical', created_at: iso(0), started_at: iso(0) },
    orders: [{ id: '1', status: 'pending', created_at: iso(5) }],
    sitreps: [],
    resources: [{ id: 'r1', status: 'available' }],
    nowMs: START + 600 * 60_000,
  });
  assert.equal(computed.kpi.dispatch_completion_rate, 0);
  assert.equal(computed.kpi.sitrep_coverage_rate, 0);
  assert.equal(computed.kpi.response_speed_score, 0);
  assert.ok(computed.kpi.overall_score < 30);
});

test('response speed score follows the documented SLA bands', () => {
  assert.equal(responseSpeedScore(10, 60, true), 100);
  assert.equal(responseSpeedScore(80, 60, true), 80);
  assert.equal(responseSpeedScore(110, 60, true), 60);
  assert.equal(responseSpeedScore(200, 60, true), 40);
  assert.equal(responseSpeedScore(1000, 60, true), 20);
  assert.equal(responseSpeedScore(null, 60, false), 0);
});

test('SLA breach count changes when the response crosses the threshold', () => {
  const event = { id: 'e', status: 'active', severity: 'critical', started_at: iso(0) };
  assert.equal(slaBreachCount(event, START + 10 * 60_000, START + 20 * 60_000), 0);
  assert.equal(slaBreachCount(event, START + 120 * 60_000, START + 120 * 60_000), 1);
  assert.equal(slaBreachCount(event, null, START + 120 * 60_000), 1);
});
