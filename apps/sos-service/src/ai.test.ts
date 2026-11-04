// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { aiChat, aiContentOf, aiStatus, jsonObjectFrom, resetAiStatusCache } from './ai';

function stubClient(chat: () => Promise<unknown>, status: () => Promise<unknown> = async () => ({ status: 'ok' })): CapabilitiesClient {
  return {
    ai: {
      chat: async () => chat(),
      status: async () => status(),
      embeddings: async () => ({}),
      decision: async () => ({}),
      route: async () => ({}),
    },
  } as unknown as CapabilitiesClient;
}

test('assistant content is extracted from an OpenAI-compatible completion', () => {
  assert.equal(aiContentOf({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }), 'hello');
  assert.equal(aiContentOf({ choices: [{ text: 'plain' }] }), 'plain');
  assert.equal(aiContentOf({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
  assert.equal(aiContentOf({ output_text: 'wrapped' }), 'wrapped');
  assert.equal(aiContentOf({ choices: [] }), null);
  assert.equal(aiContentOf(null), null);
});

test('JSON is extracted from fenced or prose-wrapped model output', () => {
  assert.deepEqual(jsonObjectFrom('{"a":1}'), { a: 1 });
  assert.deepEqual(jsonObjectFrom('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(jsonObjectFrom('Here is the plan:\n{"a":3}\nThanks.'), { a: 3 });
  assert.equal(jsonObjectFrom('no json here'), null);
  assert.equal(jsonObjectFrom('[1,2,3]'), null, 'a top-level array is not an EOP payload');
});

test('an AI provider failure becomes a typed retryable 503', async () => {
  const client = stubClient(async () => { throw new CapabilitiesError('ai_unavailable', { status: 503, code: 'ai_unavailable' }); });
  await assert.rejects(
    () => aiChat(client, [{ role: 'user', content: 'plan' }]),
    (error: any) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'ai_capability_unavailable');
      assert.equal(error.details.capability, 'ai');
      assert.equal(error.details.retryable, true);
      assert.equal(error.details.upstream_status, 503);
      return true;
    },
  );
});

test('an empty completion is rejected instead of producing a blank plan', async () => {
  const client = stubClient(async () => ({ choices: [{ message: { content: '   ' } }] }));
  await assert.rejects(() => aiChat(client, [{ role: 'user', content: 'plan' }]), (error: any) => error.code === 'ai_capability_unavailable');
});

test('aiChat returns model, usage and provider metadata', async () => {
  const client = stubClient(async () => ({
    model: 'model-x',
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { total_tokens: 9 },
  }));
  const result = await aiChat(client, [{ role: 'user', content: 'plan' }]);
  assert.equal(result.content, '{"ok":true}');
  assert.equal(result.model, 'model-x');
  assert.deepEqual(result.usage, { total_tokens: 9 });
  assert.equal(result.provider, 'synapsedx');
});

test('aiStatus reports real readiness and caches briefly', async () => {
  resetAiStatusCache();
  let calls = 0;
  const healthy = stubClient(async () => ({ choices: [] }), async () => {
    calls += 1;
    return { capability: 'ai', status: 'ok', dependency: 'synapseone-inference', upstream: { status: 'ok' }, model: 'model-x' };
  });
  const first = await aiStatus(healthy, 'https://synapsedx.sbs');
  assert.equal(first.status, 'ok');
  assert.equal(first.configured, true);
  assert.equal(first.model, 'model-x');
  await aiStatus(healthy, 'https://synapsedx.sbs');
  assert.equal(calls, 1, 'status is cached for a few seconds');

  resetAiStatusCache();
  const missing = stubClient(async () => ({ choices: [] }), async () => { throw new CapabilitiesError('not_found', { status: 404 }); });
  const status = await aiStatus(missing);
  assert.equal(status.status, 'unavailable');
  assert.equal(status.configured, false);
  assert.equal(status.reachable, true);
  resetAiStatusCache();
});
