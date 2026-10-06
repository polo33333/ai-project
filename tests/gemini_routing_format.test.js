'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callGemini } = require('../src/backend/intelligent_core/adapters/gemini');

test('Gemini routing respects zero temperature and sends JSON schema while normal chat keeps default format', async t => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }) };
  });
  const provider = { model: 'gemini-test', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'test' };
  const schema = { type: 'object', properties: { route: { type: 'string' } }, required: ['route'] };
  await callGemini({ ...provider, temperature: 0, responseFormat: schema }, [{ role: 'user', content: 'route' }], [], null);
  await callGemini(provider, [{ role: 'user', content: 'chat' }], [], null);
  assert.equal(bodies[0].generationConfig.temperature, 0);
  assert.equal(bodies[0].generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(bodies[0].generationConfig.responseJsonSchema, schema);
  assert.equal(bodies[1].generationConfig.responseJsonSchema, undefined);
});
