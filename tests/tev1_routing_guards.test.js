'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTask, convertAnswers } = require('../src/backend/automation/tev1_decision');
function answer(prepared, picks, uncertain) {
  return { answers: Object.fromEntries(Object.entries(prepared.task.questions).map(([key, query]) => {
    const keys = Object.keys(query.criteria), choice = picks[key] || (key === 'purpose' ? 'execute' : keys[0]);
    const probability = key === uncertain ? 0.55 : 0.99;
    return [key, { type: 'choice', choice, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? probability : (1 - probability) / (keys.length - 1)])) }];
  })) };
}
for (const scope of ['targeted', 'aggregate']) test(`scope cannot override an explicit rejection of ${scope} operation`, () => {
  const question = 'Explain available options';
  const prepared = buildTask(question, [{ id: 'p/w', name: 'Operation', routingScope: scope, inputs: {} }], null);
  const payload = answer(prepared, { route: 'w0', requested_scope: scope, [`${scope}_request`]: 'no' });
  assert.equal(convertAnswers(payload, prepared, question, null, { minProbability: 0.65, minMargin: 0.15 }).decision.route, 'unclear');
});
test('uncertain optional boolean is verified instead of silently omitted', () => {
  const question = 'Report with chart';
  const prepared = buildTask(question, [{ id: 'p/w', name: 'Report', routingScope: 'aggregate', inputs: {
    drawChart: { label: 'Chart', required: false, schema: { type: 'boolean' } }
  } }], null);
  const payload = answer(prepared, { route: 'w0', requested_scope: 'aggregate', aggregate_request: 'yes', input_0: 'none' }, 'input_0');
  const result = convertAnswers(payload, prepared, question, null, { minProbability: 0.65, minMargin: 0.15 }).decision;
  assert.equal(result.route, 'unclear'); assert.equal(result.inputExtractionUncertain, true);
});
