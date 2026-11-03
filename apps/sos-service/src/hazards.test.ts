// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HAZARD_TTL_HOURS,
  hazardTimestamp,
  hazardTtlHours,
  isHazardStale,
  sseHazardsFrame,
} from './hazards';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

test('hazardTimestamp prefers observed_at over created_at and updated_at', () => {
  assert.equal(
    hazardTimestamp({
      observed_at: '2026-11-03T10:00:00.000Z',
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-03T11:00:00.000Z',
    }),
    Date.parse('2026-11-03T10:00:00.000Z'),
  );
  assert.equal(hazardTimestamp({ created_at: '2026-11-03T10:00:00.000Z' }), Date.parse('2026-11-03T10:00:00.000Z'));
  assert.equal(hazardTimestamp({}), null);
  assert.equal(hazardTimestamp({ observed_at: 'not-a-date' }), null);
});

test('a hazard older than the TTL is stale', () => {
  const old = { is_active: true, observed_at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() };
  assert.equal(isHazardStale(old, NOW), true);
});

test('a fresh hazard is not stale', () => {
  const fresh = { is_active: true, observed_at: new Date(NOW - 60 * 60 * 1000).toISOString() };
  assert.equal(isHazardStale(fresh, NOW), false);
});

test('inactive, expired and timestamp-less hazards are not rewritten', () => {
  assert.equal(isHazardStale({ is_active: false, observed_at: '2020-01-01T00:00:00.000Z' }, NOW), false);
  assert.equal(isHazardStale({ status: 'expired', observed_at: '2020-01-01T00:00:00.000Z' }, NOW), false);
  assert.equal(isHazardStale({ is_active: true }, NOW), false);
});

test('the TTL is configurable but bounded', () => {
  assert.equal(hazardTtlHours(undefined), DEFAULT_HAZARD_TTL_HOURS);
  assert.equal(hazardTtlHours(2), 2);
  assert.equal(hazardTtlHours(0), DEFAULT_HAZARD_TTL_HOURS);
  assert.equal(hazardTtlHours('bad'), DEFAULT_HAZARD_TTL_HOURS);
  assert.equal(hazardTtlHours(24 * 365), 24 * 30);
});

test('SSE frames use real newline bytes and never a literal backslash-n', () => {
  const frame = sseHazardsFrame({ snapshot: [{ id: 'h1' }] });
  assert.equal(frame, 'event: hazards\ndata: {"snapshot":[{"id":"h1"}]}\n\n');
  assert.ok(frame.includes('\n\n'));
  assert.ok(frame.startsWith('event: hazards\n'));
  assert.ok(!frame.includes('\\n'));
});
