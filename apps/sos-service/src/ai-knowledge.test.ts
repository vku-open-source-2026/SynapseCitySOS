// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilitiesClient } from '@synapsedx/capabilities';
import { hazardBrief, knowledgeAsk, resetAiStatusCache, resetHazardBriefCache } from './ai';

const NOW = Date.parse('2026-11-06T16:00:00.000Z');

test('hazardBrief maps the Tier-2 grounding response and caches it', async () => {
  resetHazardBriefCache();
  let calls = 0;
  const client = {
    hazards: {
      brief: async () => {
        calls += 1;
        return {
          brief: 'Mưa lớn tại miền Trung [H1].',
          hazards: [{
            id: 'h-1', hazard_id: 'nchmf-1', title: 'TIN CẢNH BÁO MƯA LỚN',
            event_type: 'rain', severity: 'high', provinces: ['Đà Nẵng'],
            published_at: '2026-11-06T12:00:00.000Z', url: 'https://nchmf.gov.vn/a',
          }],
          model: 'test-model', fallback: false, generated_at: '2026-11-06T15:00:00.000Z', hours: 24,
        };
      },
    },
  } as unknown as CapabilitiesClient;

  const first = await hazardBrief(client, { hours: 24, limit: 8 }, NOW);
  const second = await hazardBrief(client, { hours: 24, limit: 8 }, NOW + 1_000);
  assert.equal(first.provider, 'synapsedx');
  assert.equal(first.brief, 'Mưa lớn tại miền Trung [H1].');
  assert.equal(first.hazards[0].url, 'https://nchmf.gov.vn/a');
  assert.equal(first.fallback, false);
  assert.equal(second.brief, first.brief);
  assert.equal(calls, 1);
});

test('hazardBrief returns a typed 503 when Tier-2 has no brief capability', async () => {
  resetHazardBriefCache();
  const client = {} as CapabilitiesClient;
  await assert.rejects(
    () => hazardBrief(client, {}, NOW),
    (error: any) => error.status === 503 && error.code === 'ai_capability_unavailable',
  );
});

test('knowledgeAsk maps a grounded RAG answer with citations', async () => {
  const client = {
    knowledge: {
      query: async () => ({
        answer: 'Có cảnh báo mưa lớn tại Đà Nẵng [1].',
        citations: [{ index: 1, title: 'TIN CẢNH BÁO MƯA LỚN', documentId: 'k-1', url: 'https://nchmf.gov.vn/a', publishedAt: '2026-11-06T12:00:00.000Z' }],
        entities: ['Đà Nẵng'],
        noAnswer: false,
        model: 'test-model',
      }),
    },
  } as unknown as CapabilitiesClient;
  const result = await knowledgeAsk(client, 'Tình hình mưa lớn hôm nay?', 3);
  assert.equal(result.provider, 'synapsedx');
  assert.equal(result.answer, 'Có cảnh báo mưa lớn tại Đà Nẵng [1].');
  assert.equal(result.citations[0].url, 'https://nchmf.gov.vn/a');
  assert.deepEqual(result.entities, ['Đà Nẵng']);
});

test('knowledgeAsk rejects an empty question before calling Tier-2', async () => {
  let called = false;
  const client = {
    knowledge: { query: async () => { called = true; return {}; } },
  } as unknown as CapabilitiesClient;
  await assert.rejects(
    () => knowledgeAsk(client, '   '),
    (error: any) => error.status === 400 && error.code === 'question_required',
  );
  assert.equal(called, false);
});

test('knowledgeAsk returns a typed 503 when the capability is missing', async () => {
  await assert.rejects(
    () => knowledgeAsk({} as CapabilitiesClient, 'hello'),
    (error: any) => error.status === 503 && error.code === 'ai_capability_unavailable',
  );
});

test('aiStatus cache can be reset for deterministic tests', () => {
  resetAiStatusCache();
  assert.ok(true);
});
