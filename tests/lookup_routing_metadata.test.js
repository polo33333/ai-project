'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const definitions = require('./fixtures/lookup_routing_catalog.json');
const { buildTask, convertAnswers } = require('../src/backend/automation/tev1_decision');
const { estimateTokens } = require('../src/backend/agent_core/harness/context_budget');

for (const question of ['thông tin chi tiết nv', 'thông tin chi tiết hợp đồng']) {
  test(`published catalog metadata fits TEV1 for ${question}`, () => {
    const { task, workflows } = buildTask(question, definitions, null, [{ role: 'assistant', content: 'old SQL result '.repeat(5000) }]);
    assert.equal(workflows.length, 3);
    assert.ok(estimateTokens(task) + 200 <= 2050);
    assert.ok(Object.values(task.state.workflows).some(item => item.name.includes('nhân viên')));
    assert.ok(Object.values(task.state.workflows).some(item => item.name.includes('hợp đồng')));
    const query = Object.values(task.questions).find(item => item.instructions.includes('value for query'));
    assert.match(query.instructions, /Tên hoặc mã nhân viên/);
    assert.match(query.instructions, /Tên khách hàng hoặc mã\/số hợp đồng/);
    assert.equal(definitions[0].inputs.query.required, true);
    assert.equal(task.state.history, undefined);
    assert.equal(task.questions.scope_w0, undefined);
    assert.equal(task.questions.scope_w2, undefined);
    assert.ok(task.questions.provided_0);
    assert.ok(task.questions.targeted_request);
  });
}

test('pending lookup and long chat history fit TEV1 without dropping any workflow', () => {
  const selected = definitions.find(item => item.id.startsWith('contract_lookup'));
  const pending = { id: 'pending', templateId: selected.id, input: {}, missing: [{ key: 'query', ask: selected.inputs.query.ask }] };
  const { task, workflows } = buildTask('chi tiết hđ', definitions, pending, [{ role: 'assistant', content: 'table '.repeat(5000) }]);
  assert.equal(workflows.length, 3);
  assert.ok(estimateTokens(task) + 200 <= 2050);
  assert.ok(task.questions.pending_turn);
});

test('native task is stable when database returns catalog in another order', () => {
  assert.deepEqual(buildTask('chi tiết hđ', definitions, null).task,
    buildTask('chi tiết hđ', [...definitions].reverse(), null).task);
});

function nativeAnswers(prepared, selectedId, targeted = 'yes') {
  const selected = prepared.workflows.find(item => item.definition.id === selectedId);
  return { answers: Object.fromEntries(Object.entries(prepared.task.questions).map(([key, query]) => {
    const options = Object.keys(query.criteria);
    const pick = key === 'purpose' ? 'execute' : key === 'route' ? selected.key : key === 'targeted_request' ? targeted
      : key === 'requested_scope' ? 'targeted' : key.startsWith('provided_') ? 'no'
        : key.startsWith('input_') ? options.find(value => value !== 'none') : 'aggregate';
    return [key, { type: 'choice', choice: pick, probabilities: Object.fromEntries(options.map(option => [option, option === pick ? 0.98 : 0.02 / (options.length - 1)])) }];
  })) };
}

test('native lookup asks missing identifier instead of using a word from the operation as query', () => {
  const prepared = buildTask('chi tiết hđ', definitions, null);
  const result = convertAnswers(nativeAnswers(prepared, 'contract_lookup/contract_details'), prepared, 'chi tiết hđ', null, { minProbability: 0.65, minMargin: 0.15 });
  assert.equal(result.decision.route, 'workflow');
  assert.deepEqual(result.decision.inputs, {});
});

test('independent scope rejection prevents a high-scoring lookup from executing an all-entity list', () => {
  const prepared = buildTask('danh sách toàn bộ hợp đồng', definitions, null);
  const result = convertAnswers(nativeAnswers(prepared, 'contract_lookup/contract_details', 'no'), prepared, 'danh sách toàn bộ hợp đồng', null, { minProbability: 0.65, minMargin: 0.15 });
  assert.equal(result.decision.route, 'unclear');
  assert.deepEqual(result.decision.inputs, {});
});
