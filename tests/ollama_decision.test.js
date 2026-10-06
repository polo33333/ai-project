'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchToProvider } = require('../src/backend/intelligent_core/adapters');
const tev1 = require('../src/backend/automation/tev1_decision');


test('TEV1 uses systemone with state and questions and counts every evaluation', async t => {
  const task = { state: { question: 'Xin chào' }, questions: {
    intent: { type: 'choice', instructions: 'Choose intent', criteria: { chat: 'Chat', task: 'Task' } },
    scope: { type: 'choice', instructions: 'Choose scope', criteria: { none: 'None', data: 'Data' } }
  } };
  let request;
  t.mock.method(global, 'fetch', async (url, options) => {
    request = { url, body: JSON.parse(options.body), headers: options.headers };
    return { ok: true, json: async () => ({ answers: {}, usage: { input_tokens: 40, output_tokens: 2 } }) };
  });
  const result = await dispatchToProvider({ apiFormat: 'ollama-decision', model: 'tev1:4b',
    baseUrl: 'http://127.0.0.1:11434', decisionTask: task, apiKey: 'private-key' }, [], [], null);
  assert.equal(request.url, 'http://127.0.0.1:11434/v1/systemone');
  assert.deepEqual(request.body.state, task.state);
  assert.deepEqual(request.body.questions, task.questions);
  assert.equal(request.body.model, 'tev1:4b');
  assert.equal(request.body.messages, undefined);
  assert.ok(!JSON.stringify(request).includes('private-key'));
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 2, totalTokens: 42, calls: 2 });
  assert.equal(result.metadata.decisionEvaluations, 2);
});

test('TEV1 transport errors expose status without leaking decision state or response body', async t => {
  t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500, text: async () => 'private upstream state' }));
  await assert.rejects(dispatchToProvider({ apiFormat: 'ollama-decision', model: 'tev1:4b',
    baseUrl: 'http://127.0.0.1:11434', decisionTask: { state: 'private question', questions: {} } }, [], [], null),
  error => error.code === 'ROUTING_PROVIDER_ERROR' && !error.message.includes('private'));
});

test('TEV1 candidates only contain schema-valid literal spans and never invent defaults', () => {
  const question = 'Tra cứu hợp đồng HD001';
  const values = tev1.valueCandidates(question, { type: 'string', minLength: 1 });
  assert.ok(values.some(item => item.value === 'HD001'));
  assert.ok(values.every(item => question.includes(item.quote) && item.quote.includes(item.value)));
  assert.deepEqual(tev1.valueCandidates('Báo cáo 7 tháng', { type: 'integer', minimum: 1 }), [{ value: 7, quote: '7' }]);
  assert.deepEqual(tev1.valueCandidates('Báo cáo tháng này', { type: 'integer', minimum: 1 }), []);
});

test('TEV1 bounds catalogs and input candidate sets before executing', () => {
  assert.throws(() => tev1.buildTask('request', Array.from({ length: 23 }, (_, index) => ({ id: `w${index}`, inputs: {} })), null), { code: 'ROUTING_CONTEXT_EXCEEDED' });
  assert.throws(() => tev1.valueCandidates(Array.from({ length: 30 }, (_, index) => `value${index}`).join(' '), { type: 'string' }), { code: 'ROUTING_CONTEXT_EXCEEDED' });
});

test('report confirmation resolves unclear scope but rejects explicit entity-list scope and low route confidence', () => {
  const question = 'chi tiết sản lượng điện';
  const definition = { id: 'electricity/report', name: 'Chi tiết sản lượng điện bán ra',
    routingScope: 'aggregate', description: 'Monthly electricity quantities report.', examples: [question], inputs: {} };
  const prepared = tev1.buildTask(question, [definition], null);
  const payload = picks => ({ answers: Object.fromEntries(Object.entries(prepared.task.questions).map(([key, query]) => {
    const choice = picks[key];
    const options = Object.keys(query.criteria);
    return [key, { type: 'choice', choice, probabilities: Object.fromEntries(options.map(option => [option, option === choice ? 0.96 : 0.04 / (options.length - 1)])) }];
  })) });
  const config = { minProbability: 0.65, minMargin: 0.15 };
  const picks = { route: 'w0', requested_scope: 'unclear', aggregate_request: 'yes' };
  const result = tev1.convertAnswers(payload(picks), prepared, question, null, config).decision;
  assert.equal(result.route, 'workflow');
  assert.equal(result.workflowId, definition.id);
  assert.equal(result.requestedScope, 'aggregate');
  assert.deepEqual(result.inputs, {});
  for (const requested_scope of ['targeted', 'collection']) {
    assert.equal(tev1.convertAnswers(payload({ ...picks, requested_scope }), prepared, question, null, config).decision.route, 'unclear');
  }
  assert.equal(tev1.convertAnswers(payload({ ...picks, aggregate_request: 'no' }), prepared, question, null, config).decision.route, 'unclear');
  const weak = payload(picks);
  weak.answers.route.probabilities = { chat: 0.25, unclear: 0.2, w0: 0.55 };
  assert.equal(tev1.convertAnswers(weak, prepared, question, null, config).decision.route, 'unclear');
});
