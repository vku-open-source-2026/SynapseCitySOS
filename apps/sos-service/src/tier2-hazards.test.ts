// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilitiesClient } from '@synapsedx/capabilities';
import {
  fetchTier2HazardStatus,
  fetchTier2Hazards,
  mergeHazardFeed,
  toSosHazard,
} from './tier2-hazards';

const NOW = Date.parse('2026-11-06T14:00:00.000Z');

test('toSosHazard maps a Tier-2 NCHMF warning to the SOS projection', () => {
  const row = toSosHazard({
    id: 'h-nchmf-abc',
    hazard_id: 'nchmf-abc',
    title: 'TIN CẢNH BÁO MƯA LỚN',
    description: 'Mưa to tại miền Trung',
    event_type: 'rain',
    severity: 'high',
    source: 'nchmf',
    is_active: true,
    geometry: { type: 'Point', coordinates: [108.2, 16.05] },
    provinces: ['Đà Nẵng', 'Huế'],
    url: 'https://www.nchmf.gov.vn/kttv/example-post1.html',
    published_at: '2026-11-06T12:00:00.000Z',
    fetched_at: '2026-11-06T12:05:00.000Z',
  });
  assert.ok(row);
  assert.equal(row.id, 'synapsedx-h-nchmf-abc');
  assert.equal(row.hazard_id, 'nchmf-abc');
  assert.equal(row.event_type, 'rain');
  assert.equal(row.severity, 'high');
  assert.equal(row.source, 'nchmf');
  assert.equal(row.is_active, true);
  assert.deepEqual(row.geometry, { type: 'Point', coordinates: [108.2, 16.05] });
  assert.deepEqual(row.provinces, ['Đà Nẵng', 'Huế']);
  assert.equal(row.district, 'Đà Nẵng');
  assert.equal(row.observed_at, '2026-11-06T12:00:00.000Z');
  assert.equal((row.metadata as Record<string, unknown>).tier2, true);
});

test('toSosHazard rejects records without a stable id and normalises bad values', () => {
  assert.equal(toSosHazard(null), null);
  assert.equal(toSosHazard({}), null);
  const row = toSosHazard({
    hazard_id: 'x1',
    event_type: 'meteor',
    severity: 'extreme',
    geometry: { type: 'Polygon', coordinates: [] },
  });
  assert.ok(row);
  assert.equal(row.event_type, 'other');
  assert.equal(row.severity, 'medium');
  assert.deepEqual(row.geometry, { type: 'Point', coordinates: [105.8542, 21.0285] });
});

test('mergeHazardFeed keeps the fresh Tier-2 copy for the same hazard_id', () => {
  const merged = mergeHazardFeed(
    [{ id: 'stored-1', hazard_id: 'h1', title: 'old' }, { id: 'stored-2', hazard_id: 'h2', title: 'keep' }],
    [{ id: 'feed-1', hazard_id: 'h1', title: 'new' }, { id: 'feed-3', hazard_id: 'h3', title: 'added' }],
  );
  const byId = new Map(merged.map((row) => [String(row.hazard_id), row]));
  assert.equal(byId.get('h1')?.title, 'new');
  assert.equal(byId.get('h2')?.title, 'keep');
  assert.equal(byId.get('h3')?.title, 'added');
  assert.equal(merged.length, 3);
});

test('fetchTier2Hazards caches results for the same window', async () => {
  let calls = 0;
  const client = {
    hazards: {
      today: async () => {
        calls += 1;
        return { hazards: [{ id: 'a', hazard_id: 'a', title: 'A', published_at: new Date(NOW).toISOString() }] };
      },
    },
  } as unknown as CapabilitiesClient;
  const first = await fetchTier2Hazards(client, 48, 10, NOW);
  const second = await fetchTier2Hazards(client, 48, 10, NOW + 1_000);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(calls, 1);
});

test('fetchTier2Hazards returns the last snapshot when Tier-2 fails', async () => {
  let calls = 0;
  const client = {
    hazards: {
      today: async () => {
        calls += 1;
        if (calls > 1) throw new Error('tier2 down');
        return { hazards: [{ id: 'b', hazard_id: 'b', title: 'B', published_at: new Date(NOW).toISOString() }] };
      },
    },
  } as unknown as CapabilitiesClient;
  await fetchTier2Hazards(client, 24, 10, NOW);
  const stale = await fetchTier2Hazards(client, 24, 10, NOW + 60_000);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].hazard_id, 'b');
});

test('fetchTier2HazardStatus reads and caches the crawler status', async () => {
  let calls = 0;
  const client = {
    hazards: {
      status: async () => {
        calls += 1;
        return { status: 'ok', configured: true, last_success_at: '2026-11-06T13:00:00.000Z', hazards: 15, indexed: 15 };
      },
    },
  } as unknown as CapabilitiesClient;
  const first = await fetchTier2HazardStatus(client, NOW);
  const second = await fetchTier2HazardStatus(client, NOW + 1_000);
  assert.equal(first?.status, 'ok');
  assert.equal(second?.hazards, 15);
  assert.equal(calls, 1);
});
