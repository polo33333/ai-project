'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callOllama } = require('../src/backend/intelligent_core/adapters/ollama');

test('Ollama adapter disables thinking by default', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let sentBody;
  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: 'ok' }, done_reason: 'stop' }) };
  };

  const result = await callOllama({ baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' }, [], [], null);
  assert.equal(sentBody.think, false);
  assert.equal(result.content, 'ok');
  assert.equal(result.metadata.doneReason, 'stop');
});

test('Ollama adapter retries without thinking when the first response has only thinking', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const bodies = [];
  global.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => bodies.length === 1
        ? { message: { content: '', thinking: 'reasoning' }, done_reason: 'length', prompt_eval_count: 20, eval_count: 100 }
        : { message: { content: 'final answer' }, done_reason: 'stop', prompt_eval_count: 8, eval_count: 12 }
    };
  };

  const result = await callOllama({ baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b', think: true }, [], [], null);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].think, true);
  assert.equal(bodies[1].think, false);
  assert.equal(result.content, 'final answer');
  assert.deepEqual(result.usage, { inputTokens: 28, outputTokens: 112, totalTokens: 140, calls: 2 });
  assert.equal(result.metadata.requestCount, 2);
});

test('Ollama adapter exposes diagnostics when the final response is still empty', async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ message: { content: '' }, done_reason: 'length', eval_count: 2048 })
  });

  await assert.rejects(
    callOllama({ baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' }, [], [], null),
    error => error.code === 'OLLAMA_EMPTY_RESPONSE'
      && error.message.includes('done_reason=length')
      && error.message.includes('eval_count=2048')
  );
});
