// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectorNotConfigured,
  connectorStatusFromRuns,
  connectorUnavailable,
  ingestStatusFromRun,
  isVndmsConnectorJob,
  isVndmsRecord,
  normalizeIngestBatch,
  toVndmsHazard,
} from './vndms';

test('stored hazard converts to the flat VNDMS contract', () => {
  const wire = toVndmsHazard({
    id: 'h1', hazard_id: 'VNDMS-1', title: 'Flood A', description: 'Rising', event_type: 'flood',
    severity: 'critical', source: 'vndms', is_active: true, district: 'Hai Chau',
    geometry: { type: 'Point', coordinates: [108, 16] }, observed_at: '2026-11-04T00:00:00.000Z',
  });
  assert.ok(wire);
  assert.equal(wire?.lat, 16);
  assert.equal(wire?.lon, 108);
  assert.equal(wire?.label, 'Flood A');
  assert.equal(wire?.warning_type, 'warning_flood');
  assert.equal(wire?.warning_level, 3);
  assert.equal(wire?.severity, 'high');
  assert.deepEqual(wire?.geometry, { type: 'Point', coordinates: [108, 16] });
});

test('VNDMS detection distinguishes manual hazards', () => {
  assert.equal(isVndmsRecord({ source: 'vndms' }), true);
  assert.equal(isVndmsRecord({ warning_type: 'warning_rain' }), true);
  assert.equal(isVndmsRecord({ source: 'manual', event_type: 'flood' }), false);
});

test('ingest batch normalises, deduplicates by hazard id and rejects invalid records', () => {
  const batch = normalizeIngestBatch({
    records: [
      { hazard_id: 'V-1', title: 'Flood', event_type: 'flood', severity: 'high', lat: 16, lon: 108, warning_level: 3 },
      { hazard_id: 'V-1', title: 'Flood (duplicate)', event_type: 'flood', lat: 16, lon: 108 },
      { title: 'Missing id', lat: 16, lon: 108 },
      { hazard_id: 'V-2', title: 'Missing point' },
      { hazard_id: 'V-3', title: 'Storm', event_type: 'storm', lat: 16, lon: 108 },
    ],
  }, '2026-11-04T00:00:00.000Z');
  assert.equal(batch.accepted.length, 3);
  assert.equal(batch.rejected.length, 2);
  assert.deepEqual(batch.accepted.map((entry) => entry.hazard.hazard_id), ['V-1', 'V-1', 'V-3']);
  assert.equal(batch.accepted[0].hazard.source, 'vndms');
  assert.deepEqual(batch.accepted[0].hazard.geometry, { type: 'Point', coordinates: [108, 16] });
  assert.equal(batch.rejected[0].reason, 'hazard_id_required');
  assert.equal(batch.rejected[1].reason, 'point_geometry_required');
});

test('ingest status is unconfigured before the first run and stale after the window', () => {
  const empty = ingestStatusFromRun(null, Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(empty.status, 'unconfigured');
  assert.equal(empty.configured, false);

  const ready = ingestStatusFromRun({
    status: 'succeeded', finished_at: '2026-11-04T11:55:00.000Z', last_success_at: '2026-11-04T11:55:00.000Z',
    records_ingested: 4, records_rejected: 0,
  }, Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(ready.status, 'ready');
  assert.equal(ready.stale, false);

  const stale = ingestStatusFromRun({
    status: 'succeeded', finished_at: '2026-11-04T10:00:00.000Z', last_success_at: '2026-11-04T10:00:00.000Z',
  }, Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(stale.status, 'stale');

  const failed = ingestStatusFromRun({
    status: 'failed', finished_at: '2026-11-04T11:55:00.000Z', error: 'upstream timeout',
  }, Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(failed.status, 'error');
});

// ── Tier-2 scheduled connector projection ───────────────────────────────────

test('the VNDMS connector job is identified by name, payload or dataset', () => {
  assert.equal(isVndmsConnectorJob({ id: 'vndms-connector', name: 'VNDMS feed ingest' }), true);
  assert.equal(isVndmsConnectorJob({ id: 'feed', payload: { source: 'vndms' } }), true);
  assert.equal(isVndmsConnectorJob({ id: 'hazards-sync', datasetId: 'sos-hazard-layers' }), true);
  assert.equal(isVndmsConnectorJob({ id: 'email-digest', name: 'Email digest' }), false);
});

test('connector status is derived from the job and its run history', () => {
  const job = {
    id: 'vndms-connector', name: 'VNDMS feed ingest', kind: 'ingest',
    schedule: { everySeconds: 300 }, enabled: true,
  };
  const runs = [
    { id: 'r2', status: 'success', startedAt: '2026-11-04T11:50:00.000Z', finishedAt: '2026-11-04T11:55:00.000Z', attempt: 1, lastError: null },
    { id: 'r1', status: 'failed', startedAt: '2026-11-04T11:40:00.000Z', finishedAt: '2026-11-04T11:41:00.000Z', attempt: 1, lastError: 'timeout' },
  ];
  const status = connectorStatusFromRuns(job, runs, Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(status.configured, true);
  assert.equal(status.available, true);
  assert.equal(status.job_id, 'vndms-connector');
  assert.equal(status.enabled, true);
  assert.deepEqual(status.schedule, { cron: null, every_seconds: 300 });
  assert.equal(status.last_run_status, 'success');
  assert.equal(status.last_success_at, '2026-11-04T11:55:00.000Z');
  assert.equal(status.runs_considered, 2);
  assert.equal(status.error, null);

  const failed = connectorStatusFromRuns(job, [
    { id: 'r3', status: 'failed', startedAt: '2026-11-04T11:59:00.000Z', finishedAt: '2026-11-04T11:59:30.000Z', lastError: 'connection reset' },
  ], Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(failed.last_run_status, 'failed');
  assert.equal(failed.error, 'connection reset');

  const disabled = connectorStatusFromRuns({ ...job, enabled: false }, [], Date.parse('2026-11-04T12:00:00.000Z'));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.error, 'connector_disabled');
  assert.equal(disabled.last_success_at, null);
});

test('ingest status combines a validated push run with connector freshness', () => {
  const connector = connectorStatusFromRuns(
    { id: 'vndms-connector', name: 'VNDMS feed ingest', schedule: { cron: '*/5 * * * *' }, enabled: true },
    [{ id: 'r1', status: 'success', finishedAt: '2026-11-04T11:55:00.000Z' }],
    Date.parse('2026-11-04T12:00:00.000Z'),
  );
  const ready = ingestStatusFromRun(null, Date.parse('2026-11-04T12:00:00.000Z'), connector);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.configured, true);
  assert.equal(ready.last_success_at, '2026-11-04T11:55:00.000Z');
  assert.equal(ready.last_run_at, '2026-11-04T11:55:00.000Z');
  assert.deepEqual(ready.connector, connector);

  const stale = ingestStatusFromRun(null, Date.parse('2026-11-04T14:00:00.000Z'), connector);
  assert.equal(stale.status, 'stale');

  const unconfigured = ingestStatusFromRun(null, Date.parse('2026-11-04T12:00:00.000Z'), connectorNotConfigured('2026-11-04T12:00:00.000Z'));
  assert.equal(unconfigured.status, 'unconfigured');
  assert.equal(unconfigured.configured, false);

  const unavailable = connectorUnavailable({ status: 503 }, '2026-11-04T12:00:00.000Z');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.error, 'tier2_jobs_unreachable');
  const withUnavailable = ingestStatusFromRun({ status: 'succeeded', finished_at: '2026-11-04T11:55:00.000Z', last_success_at: '2026-11-04T11:55:00.000Z' }, Date.parse('2026-11-04T12:00:00.000Z'), unavailable);
  assert.equal(withUnavailable.status, 'degraded', 'an unavailable connector is a monitoring gap, never silently healthy');
  assert.equal((withUnavailable.connector as { available: boolean }).available, false);
});
