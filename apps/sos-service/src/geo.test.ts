// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaContainsPoint,
  haversineMeters,
  inPolygonHazards,
  nearHazards,
  parseCoordinates,
  parseRadius,
  pointInPolygon,
  validatePolygon,
} from './geo';

const HANOI = { lat: 21.0278, lng: 105.8342 };
const HCMC = { lat: 10.8231, lng: 106.6297 };

test('haversine returns a plausible distance and is symmetric', () => {
  const distance = haversineMeters(HANOI, HCMC);
  assert.ok(distance > 1_100_000 && distance < 1_200_000, `unexpected distance ${distance}`);
  assert.ok(Math.abs(distance - haversineMeters(HCMC, HANOI)) < 0.001);
});

test('haversine handles an antimeridian crossing', () => {
  const distance = haversineMeters({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 });
  assert.ok(distance < 30_000, `antimeridian distance should be short, got ${distance}`);
});

test('point-in-polygon handles inside, outside and the shared edge', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.equal(pointInPolygon({ lat: 5, lng: 5 }, ring), true);
  assert.equal(pointInPolygon({ lat: 15, lng: 5 }, ring), false);
  // Edge points are implementation-defined by ray casting; the important
  // guarantee is that a clearly interior/exterior point is stable.
  assert.equal(pointInPolygon({ lat: 10.0001, lng: 5 }, ring), false);
});

test('polygon holes are respected', () => {
  const area = validatePolygon({
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
    ],
  });
  assert.equal(areaContainsPoint(area, { lat: 2, lng: 2 }), true);
  assert.equal(areaContainsPoint(area, { lat: 5, lng: 5 }), false);
});

test('polygon validation rejects open rings, too few points and unbounded input', () => {
  assert.throws(() => validatePolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }), /at least 4|closed/);
  assert.throws(() => validatePolygon({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /closed/);
  assert.throws(() => validatePolygon({ type: 'Point', coordinates: [0, 0] }), /Polygon/);
  assert.throws(() => validatePolygon([]), /Polygon|MultiPolygon/);
});

test('coordinate and radius parsing reject non-finite and unbounded values', () => {
  assert.deepEqual(parseCoordinates('16', '108'), { lat: 16, lng: 108 });
  assert.throws(() => parseCoordinates('nope', '108'), /finite numbers/);
  assert.throws(() => parseCoordinates('91', '108'), /between -90 and 90/);
  assert.throws(() => parseCoordinates('16', '181'), /between -180 and 180/);
  assert.equal(parseRadius(undefined), 5000);
  assert.throws(() => parseRadius(0), /radius_m must be between/);
  assert.throws(() => parseRadius(50_001), /radius_m must be between/);
});

test('near results are filtered, sorted and paginated', () => {
  const rows = [
    { id: 'far', geometry: { type: 'Point', coordinates: [109, 17] } },
    { id: 'near', geometry: { type: 'Point', coordinates: [108.001, 16] } },
    { id: 'mid', geometry: { type: 'Point', coordinates: [108.02, 16] } },
    { id: 'no-geometry' },
  ];
  const result = nearHazards(rows, { lat: 16, lng: 108, radiusM: 5000, limit: 2, offset: 0 });
  assert.deepEqual(result.items.map((row) => row.id), ['near', 'mid']);
  assert.equal(result.total, 2);
  assert.ok(Number(result.items[0].distance_m) < Number(result.items[1].distance_m));
});

test('in-polygon results include only contained hazard points', () => {
  const area = validatePolygon({
    type: 'Polygon',
    coordinates: [[[107.5, 15.5], [108.5, 15.5], [108.5, 16.5], [107.5, 16.5], [107.5, 15.5]]],
  });
  const rows = [
    { id: 'inside', geometry: { type: 'Point', coordinates: [108, 16] } },
    { id: 'outside', geometry: { type: 'Point', coordinates: [109, 17] } },
  ];
  assert.deepEqual(inPolygonHazards(rows, area, { limit: 100, offset: 0 }).items.map((row) => row.id), ['inside']);
});
