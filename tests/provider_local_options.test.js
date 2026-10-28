'use strict';
// Per-provider Ollama options (temperature, think, keepAlive): stored and
// validated by the provider manager, sent by the Ollama adapter, and removed
// again so the shared LOCAL_MODEL_* settings apply.
const test = require('node:test');
const assert = require('node:assert/strict');
const providerManager = require('../src/backend/services/ai_provider_manager');
const { callOllama } = require('../src/backend/assistant/adapters/ollama');

const base = { name: 'Local', type: 'Ollama (Local)', apiFormat: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b' };

test('Ollama options are stored, validated and cleared per provider', t => {
  const created = providerManager.addProvider({ ...base, temperature: '0.3', think: 'true', keepAlive: '30m' });
  t.after(() => providerManager.deleteProvider(created.id));
  assert.deepEqual([created.temperature, created.think, created.keepAlive], [0.3, true, '30m']);

  const updated = providerManager.updateProvider(created.id, { think: 'false' });
  assert.deepEqual([updated.temperature, updated.think, updated.keepAlive], [0.3, false, '30m']);

  for (const [field, value, message] of [['temperature', '2.5', /từ 0 đến 2/], ['think', 'maybe', /bật, tắt/], ['keepAlive', '-1', /10m, 1h/]])
    assert.throws(() => providerManager.updateProvider(created.id, { [field]: value }), message);
  // A rejected update changes nothing.
  assert.equal(providerManager.getProviderForExecution(created.id).keepAlive, '30m');

  const cleared = providerManager.updateProvider(created.id, { temperature: '', think: '', keepAlive: '' });
  const stored = providerManager.getProviderForExecution(created.id);
  assert.deepEqual([cleared.temperature, cleared.think, cleared.keepAlive], [undefined, undefined, undefined]);
  assert.ok(!('temperature' in stored) && !('think' in stored) && !('keepAlive' in stored));
});

test('the Ollama adapter sends provider options and falls back to the shared settings', async t => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) };
  });
  const saved = ['LOCAL_MODEL_TEMPERATURE', 'LOCAL_MODEL_THINK', 'LOCAL_MODEL_KEEP_ALIVE'].map(key => [key, process.env[key]]);
  t.after(() => { for (const [key, value] of saved) value === undefined ? delete process.env[key] : process.env[key] = value; });
  Object.assign(process.env, { LOCAL_MODEL_TEMPERATURE: '0.1', LOCAL_MODEL_THINK: 'false', LOCAL_MODEL_KEEP_ALIVE: '10m' });

  await callOllama({ ...base, temperature: 0.4, think: true, keepAlive: '1h' }, [], [], null);
  await callOllama(base, [], [], null);
  assert.deepEqual([bodies[0].options.temperature, bodies[0].think, bodies[0].keep_alive], [0.4, true, '1h']);
  assert.deepEqual([bodies[1].options.temperature, bodies[1].think, bodies[1].keep_alive], [0.1, false, '10m']);
});
