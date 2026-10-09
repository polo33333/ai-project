'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withModelTokenUsage } = require('../src/backend/utils/model_token_usage');

test('same Gemini model combines routing and all execution calls without double counting', () => {
  const usage = { available: true, inputTokens: 12118, outputTokens: 177, totalTokens: 12295, calls: 6 };
  const routing = { stages: [
    { model: 'tev1:4b', inputTokens: 180, outputTokens: 1, calls: 1 },
    { model: 'tev1:4b', inputTokens: 345, outputTokens: 1, calls: 1 },
    { model: 'gemini', inputTokens: 269, outputTokens: 11, calls: 1 }
  ] };
  const result = withModelTokenUsage(usage, routing, 'gemini');
  assert.deepEqual(result.byModel, [
    { model: 'tev1:4b', inputTokens: 525, outputTokens: 2, totalTokens: 527, calls: 2 },
    { model: 'gemini', inputTokens: 11593, outputTokens: 175, totalTokens: 11768, calls: 4 }
  ]);
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'calls']) {
    assert.equal(result.byModel.reduce((sum, x) => sum + x[key], 0), usage[key]);
  }
});

test('greeting uses TEV1 alone and incomplete upstream totals do not produce fake model counts', () => {
  const routing = { stages: [{ model: 'tev1:4b', inputTokens: 179, outputTokens: 1, calls: 1 }] };
  const result = withModelTokenUsage({ available: true, inputTokens: 179, outputTokens: 1, totalTokens: 180, calls: 1 }, routing, 'gemini');
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].model, 'tev1:4b');
  assert.equal(withModelTokenUsage({ available: true, inputTokens: 0, outputTokens: 0, calls: 0 }, routing, 'gemini').byModel, undefined);
});
