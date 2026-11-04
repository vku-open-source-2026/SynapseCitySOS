// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEopDraft, buildEopPrompt, draftFromAiPayload, orderIdFor, planOrderSeeds } from './eop';

const event = {
  id: 'e-1',
  event_code: 'EV-1',
  title: 'Flood in Hai Chau',
  event_type: 'flood',
  severity: 'high',
  location: { district: 'Hai Chau', ward: 'Thach Thang' },
};

test('draft generation is deterministic and event-specific', () => {
  const draft = buildEopDraft({
    event,
    hazards: [{ id: 'h1', title: 'Flood A', severity: 'high' }],
    resources: [{ id: 'r1', name: 'Team 1', status: 'available', resource_type: 'personnel', district: 'Hai Chau' }],
    generatedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.equal(draft.title, 'EOP — Flood in Hai Chau');
  assert.equal(draft.version, 1);
  assert.ok(draft.objectives.length >= 3);
  assert.ok(draft.actions.length >= 4);
  assert.ok(draft.assignment_matrix.length === draft.actions.length);
  assert.ok(draft.evacuation_plan.length >= 3);
  assert.ok(draft.markdown_body.includes('Hai Chau'));
  assert.equal(draft.metadata.generated_by, 'deterministic-fallback');
  assert.equal(draft.metadata.ai_provider, null);
  assert.deepEqual((draft.metadata.source_refs as Record<string, unknown>).hazard_ids, ['h1']);

  const again = buildEopDraft({
    event,
    hazards: [{ id: 'h1', title: 'Flood A', severity: 'high' }],
    resources: [{ id: 'r1', name: 'Team 1', status: 'available', resource_type: 'personnel', district: 'Hai Chau' }],
    generatedAt: '2026-11-04T00:00:00.000Z',
  });
  assert.deepEqual(again, draft);
});

test('different event types produce different actions', () => {
  const flood = buildEopDraft({ event, hazards: [], resources: [] });
  const storm = buildEopDraft({ event: { ...event, event_type: 'storm' }, hazards: [], resources: [] });
  assert.notDeepEqual(flood.actions.map((action) => action.action_id), storm.actions.map((action) => action.action_id));
});

test('plan order seeds map actions one-to-one and ignore empty plans', () => {
  const draft = buildEopDraft({ event, hazards: [], resources: [] });
  const seeds = planOrderSeeds({ ...draft, id: 'plan-1', emergency_event_id: 'e-1' });
  assert.equal(seeds.length, draft.actions.length);
  assert.equal(seeds[0].action_id, draft.actions[0].action_id);
  assert.deepEqual(planOrderSeeds({ id: 'plan-2', actions: [] }), []);
});

test('order ids are deterministic and bounded', () => {
  assert.equal(orderIdFor('plan-1', 'activate-command'), 'dsp-plan-1-activate-command');
  assert.equal(orderIdFor('plan-1', 'activate-command'), orderIdFor('plan-1', 'activate-command'));
  assert.ok(orderIdFor('x'.repeat(500), 'y'.repeat(500)).length <= 180);
});

// ── Tier-2 AI prompt and payload mapping ────────────────────────────────────

test('the AI prompt carries the event, linked hazards and resources', () => {
  const messages = buildEopPrompt({
    event,
    hazards: [{ id: 'h1', title: 'Flood A', severity: 'high' }],
    resources: [{ id: 'r1', name: 'Team 1', resource_type: 'personnel', status: 'available' }],
    additionalContext: 'Ưu tiên bệnh viện',
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('JSON'));
  const context = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  assert.equal(context.event.id, 'e-1');
  assert.equal(context.event.event_type, 'flood');
  assert.equal(context.linked_hazards[0].id, 'h1');
  assert.equal(context.resources[0].id, 'r1');
  assert.equal(context.additional_context, 'Ưu tiên bệnh viện');
});

test('an AI payload becomes a complete draft with provenance', () => {
  const draft = draftFromAiPayload(
    { event, hazards: [], resources: [], generatedAt: '2026-11-04T00:00:00.000Z' },
    2,
    {
      summary: 'Kế hoạch AI',
      objectives: ['Mục tiêu 1', 'Mục tiêu 2'],
      operational_phases: ['prepare', 'respond'],
      actions: [
        { action_id: 'Evacuate People', title: 'Sơ tán', description: 'Sơ tán dân', phase: 'respond', priority: 'critical', estimated_minutes: 30, required_capability: 'personnel', dependencies: ['activate'] },
        { title: 'Khôi phục điện', description: 'Khôi phục', phase: 'recover', estimated_minutes: 0 },
      ],
      evacuation_plan: ['Tuyến 1'],
    },
    { model: 'model-x', promptVersion: 'sos-eop-prompt-v1', generatedAt: '2026-11-04T00:00:00.000Z', usage: { total_tokens: 10 } },
  );
  assert.equal(draft.version, 2);
  assert.equal(draft.metadata.generated_by, 'tier2-ai');
  assert.equal(draft.metadata.model, 'model-x');
  assert.equal(draft.metadata.prompt_version, 'sos-eop-prompt-v1');
  assert.equal(draft.summary, 'Kế hoạch AI');
  assert.deepEqual(draft.operational_phases, ['prepare', 'respond']);
  assert.equal(draft.actions.length, 2);
  assert.equal(draft.actions[0].action_id, 'evacuate-people');
  assert.equal(draft.actions[1].action_id, 'action-2');
  assert.equal(draft.actions[1].required_capability, 'personnel');
  assert.equal(draft.actions[1].estimated_minutes, 60, 'a non-positive duration falls back to the doctrine default');
  assert.equal(draft.assignment_matrix.length, draft.actions.length);
  assert.deepEqual(draft.evacuation_plan, ['Tuyến 1']);
  assert.ok(draft.fallback_plan.length > 0, 'missing sections fall back to the event-specific plan');
  assert.ok(draft.markdown_body.includes('AI (model-x)'));
});

test('an AI payload without objectives or actions is rejected, not padded silently', () => {
  assert.throws(
    () => draftFromAiPayload({ event, hazards: [], resources: [] }, 1, { objectives: [], actions: [{ title: 'x' }] }, { model: null, promptVersion: 'v1', generatedAt: '2026-11-04T00:00:00.000Z' }),
    (error: any) => error.code === 'ai_draft_invalid',
  );
  assert.throws(
    () => draftFromAiPayload({ event, hazards: [], resources: [] }, 1, { objectives: ['ok'], actions: [] }, { model: null, promptVersion: 'v1', generatedAt: '2026-11-04T00:00:00.000Z' }),
    (error: any) => error.code === 'ai_draft_invalid',
  );
});
