// Compatibility coverage for the pre-flag API; current routing is covered by chat_router.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('scope evidence formatting is repaired once without accepting invented quotes', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpret } = require('../src/backend/automation/workflow_interpreter');
  t.mock.method(providers, 'getProviderForExecution', () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const definition = { id: 'report/sample', name: 'Report', description: 'Catalog report', examples: [], inputs: {} };
  for (const evidence of ['report please', 'invented quote']) {
    let calls = 0;
    t.mock.method(adapters, 'dispatchToProvider', async () => ({ content: JSON.stringify(++calls === 1 ? { intent: 'workflow', templateId: definition.id } : { matches: true, evidence: calls === 2 ? 'Explanation: report please' : evidence }) }));
    const result = await interpret('report please', [definition], null, {});
    assert.equal(calls, 3);
    assert.equal(result.templateId, evidence === 'report please' ? definition.id : null);
  }
});

test('negative routing is reviewed semantically for arbitrary catalog domains and still scope-checked', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpret } = require('../src/backend/automation/workflow_interpreter');
  t.mock.method(providers, 'getProviderForExecution', () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  for (const [id, question] of [['inventory/monthly', 'Xem tồn kho'], ['service/summary', 'Tình hình bảo trì']]) {
    const definition = { id, name: 'Báo cáo theo cấu hình', description: question, examples: ['Tạo báo cáo định kỳ và xuất file'], inputs: {}, instructions: 'Dùng kỳ mặc định khi không chỉ định.' };
    const events = [], requests = [];
    t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
      requests.push(messages);
      return { content: JSON.stringify(requests.length === 1 ? { intent: 'chat', templateId: null } : requests.length === 2 ? { intent: 'workflow', templateId: id, inputs: {}, evidence: {} } : { matches: true, evidence: question }) };
    });
    const result = await interpret(question, [definition], null, { onWorkflowRouting: event => events.push(event) });
    assert.equal(result.templateId, id);
    assert.equal(requests.length, 3);
    assert.equal(JSON.parse(requests[2][1].content).definition.guidance, definition.instructions);
    assert.equal(events.at(-1).reason, 'semantic_match');
    let calls = 0;
    t.mock.method(adapters, 'dispatchToProvider', async () => ({ content: JSON.stringify(++calls === 1 ? { intent: 'unclear' } : calls === 2 ? { intent: 'workflow', templateId: id } : { matches: false, evidence: question }) }));
    assert.equal((await interpret(question, [definition], null, {})).templateId, null);
  }
});

test('routing reports invalid output and provider errors; cancellation never falls back to execution', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpret } = require('../src/backend/automation/workflow_interpreter');
  t.mock.method(providers, 'getProviderForExecution', () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const events = [], options = { onWorkflowRouting: event => events.push(event) };
  t.mock.method(adapters, 'dispatchToProvider', async () => ({ content: 'not JSON' }));
  assert.equal(await interpret('request', [], null, options), null);
  assert.equal(events.at(-1).reason, 'invalid_json');
  t.mock.method(adapters, 'dispatchToProvider', async () => { throw new Error('secret provider detail'); });
  assert.equal(await interpret('request', [], null, options), null);
  assert.deepEqual(events.at(-1), { reason: 'provider_error', stage: 'classification' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(interpret('request', [], null, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(events.at(-1).reason, 'cancelled');
});
