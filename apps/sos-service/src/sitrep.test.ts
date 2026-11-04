// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublishable, revisionFromDelta, validateSitrepCreate, validateSitrepUpdate } from './sitrep';

const period = {
  reporting_period_start: '2026-11-04T08:00:00.000Z',
  reporting_period_end: '2026-11-04T14:00:00.000Z',
};

test('SITREP create requires event, title, period and non-negative counters', () => {
  const missing = validateSitrepCreate({}, { username: 'qa' });
  assert.ok(missing.errors.some((error) => error.field === 'emergency_event_id'));
  assert.ok(missing.errors.some((error) => error.field === 'title'));
  assert.ok(missing.errors.some((error) => error.field === 'reporting_period_start'));

  const negative = validateSitrepCreate({ emergency_event_id: 'e', title: 'T', ...period, casualties: -2 }, { username: 'qa' });
  assert.ok(negative.errors.some((error) => error.field === 'casualties'));

  const ok = validateSitrepCreate({ emergency_event_id: 'e', title: 'T', ...period, casualties: 2, numbers: { deaths: 0 } }, { username: 'qa' });
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.value.author, 'qa');
  assert.equal(ok.value.casualties, 2);
  assert.equal((ok.value.numbers as Record<string, unknown>).deaths, 0);
});

test('a SITREP cannot be created already published', () => {
  const result = validateSitrepCreate({ emergency_event_id: 'e', title: 'T', ...period, status: 'published' }, { username: 'qa' });
  assert.ok(result.errors.some((error) => error.code === 'publish_requires_review'));
  assert.equal(result.value.status, 'draft');
});

test('published SITREPs are immutable and status cannot move backwards', () => {
  assert.throws(() => validateSitrepUpdate({ title: 'x' }, { status: 'published' }), /cannot be mutated/);
  assert.throws(() => validateSitrepUpdate({ status: 'draft' }, { status: 'review_pending' }), /cannot move/);
});

test('publishing requires content and a reviewable state', () => {
  assert.throws(() => assertPublishable({ status: 'published' }), /already published/);
  assert.throws(() => assertPublishable({ status: 'draft', snapshot: {} }), /needs a snapshot/);
  assert.doesNotThrow(() => assertPublishable({ status: 'review_pending', snapshot: { summary: 'ok' } }));
  assert.throws(() => assertPublishable({ status: 'draft', snapshot: { summary: 'ok' } }), /review_pending/);
});

test('a delta against a published SITREP creates a new revision', () => {
  const revision = revisionFromDelta(
    { id: 's1', status: 'published', version: 1, emergency_event_id: 'e', title: 'T', author: 'qa' },
    { action_type: 'update', changes: { casualties: 3 } },
    { username: 'operator' },
    '2026-11-04T12:00:00.000Z',
  );
  assert.notEqual(revision.id, 's1');
  assert.equal(revision.amends_sitrep_id, 's1');
  assert.equal(revision.version, 2);
  assert.equal(revision.status, 'draft');
  assert.equal((revision.deltas as Array<Record<string, unknown>>)[0].actor_id, 'operator');
});
