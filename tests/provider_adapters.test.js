'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callGemini } = require('../src/backend/assistant/adapters/gemini');
const { callAnthropic } = require('../src/backend/assistant/adapters/anthropic');
const { callOpenAI } = require('../src/backend/assistant/adapters/openai');

test('Gemini preserves every tool call and signed part, with all system context', async t => {
  const parts = [{ text: 'private thought', thought: true }, { functionCall: { name: 'first', args: {} }, thoughtSignature: 'signature' }, { functionCall: { name: 'second', args: {} } }];
  let request;
  t.mock.method(global, 'fetch', async (_, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }] }) }; });
  const provider = { baseUrl: 'https://test.invalid', supportsToolCalling: true };
  const messages = [{ role: 'system', content: 'primary' }, { role: 'system', content: 'memory' }, { role: 'user', content: 'go' }];
  const response = await callGemini(provider, messages, []);
  assert.equal(response.tool_calls.length, 2);
  assert.equal(new Set(response.tool_calls.map(call => call.id)).size, 2);
  assert.deepEqual(response.rawParts, parts);
  assert.equal(response.content, null);
  assert.equal(request.systemInstruction.parts[0].text, 'primary\n\nmemory');
  await callGemini(provider, [...messages, { ...response, role: 'assistant' },
    ...response.tool_calls.map(call => ({ role: 'tool', name: call.function.name, tool_call_id: call.id, content: '{"success":true}' }))], []);
  assert.deepEqual(request.contents.find(item => item.role === 'model').parts, parts);
  assert.equal(request.contents.filter(item => item.parts?.[0]?.functionResponse).length, 2);
});

test('Anthropic preserves every tool call and combines text blocks', async t => {
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ stop_reason: 'tool_use', content: [
    { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
    { type: 'tool_use', id: 'a', name: 'first', input: {} }, { type: 'tool_use', id: 'b', name: 'second', input: {} }
  ] }) }));
  const response = await callAnthropic({ baseUrl: 'https://test.invalid' }, [], []);
  assert.equal(response.tool_calls.length, 2);
  assert.equal(response.content, 'one\ntwo');
  assert.equal(response.finish_reason, 'tool_use');
});

test('adapters preserve HTTP status for recoverable fallback decisions', async t => {
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"slow down"}}' }));
  for (const adapter of [callOpenAI, callGemini, callAnthropic]) {
    await assert.rejects(() => adapter({ baseUrl: 'https://test.invalid' }, [], []), error => error.status === 429);
  }
});

test('Anthropic caches the leading system block and counts cached prompt tokens as input', async t => {
  let request;
  t.mock.method(global, 'fetch', async (_, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({
    stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 20, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0, output_tokens: 5 } }) }; });
  const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'go' }, { role: 'system', content: 'clock' }];
  const response = await callAnthropic({ baseUrl: 'https://test.invalid' }, messages, []);
  assert.deepEqual(request.system, [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'clock' }]);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'go' }]);
  assert.deepEqual(response.usage, { inputTokens: 1520, outputTokens: 5, totalTokens: 1525, cachedInputTokens: 1500, cacheWriteTokens: 0 });

  process.env.ANTHROPIC_PROMPT_CACHE = 'false';
  t.after(() => { delete process.env.ANTHROPIC_PROMPT_CACHE; });
  await callAnthropic({ baseUrl: 'https://test.invalid' }, messages, []);
  assert.equal(request.system[0].cache_control, undefined);
});
