'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('scope evidence formatting is repaired once without accepting invented quotes', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpret } = require('../src/backend/automation/orchestrator');
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
  const { interpret } = require('../src/backend/automation/orchestrator');
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
  const { interpret } = require('../src/backend/automation/orchestrator');
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
test('shared workflow interpretation rejects invented IDs/slots and keeps semantic abstention', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const orchestrator = require('../src/backend/automation/orchestrator');
  const admin = { accountId: 'actor', permissions: ['admin'] };
  let record = await automation.registry.import(require('../src/backend/automation/pilot.json'), admin);
  await automation.registry.test(record.id, admin); record = await automation.repository.get('catalog', record.id); await automation.registry.publish(record.id, admin, record.revision);
  await automation.configure({ enabled: true, revision: null }, admin);
  t.mock.method(providers, 'getProviderForExecution', () => ({ baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  let answer;
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => ({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, calls: 1 }, content: JSON.stringify(messages[0].content.startsWith('Verify business scope') ? { matches: answer.scopeMatches !== false, evidence: JSON.parse(messages[1].content).question } : { intent: 'workflow', ...answer }) }));
  const options = id => ({ session: { accountId: 'actor', id }, permissions: ['admin'] });
  answer = { templateId: 'phase1_examples/lookup', inputs: { code: 'A001', permissions: ['admin'] }, evidence: { code: 'A001', permissions: 'A001' } };
  let response = await orchestrator.handle('Tìm mã A001', options('valid'));
  assert.equal(response.execution.status, 'READY'); assert.deepEqual(response.execution.inputs, { code: 'A001' });
  assert.deepEqual(response.tokenUsage, { available: true, inputTokens: 200, outputTokens: 40, totalTokens: 240, calls: 2 });
  assert.deepEqual((await automation.repository.get('runs', response.execution.id)).tokenUsage, response.tokenUsage);
  const dispatchMock = adapters.dispatchToProvider;
  let repairCalls = 0;
  adapters.dispatchToProvider = async (_, messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Verify business scope') ? { matches: true, evidence: 'Tìm mã A004' } : { intent: ++repairCalls === 1 ? 'slot_answer' : 'workflow', templateId: 'phase1_examples/lookup', inputs: { code: 'A004' }, evidence: { code: 'A004' } }) });
  response = await orchestrator.handle('Tìm mã A004', options('repair'));
  assert.equal(repairCalls, 2); assert.equal(response.execution.inputs.code, 'A004');
  repairCalls = 0;
  adapters.dispatchToProvider = async () => ({ content: JSON.stringify({ intent: ++repairCalls === 1 ? 'slot_answer' : 'chat', templateId: null, inputs: {}, evidence: {} }) });
  assert.equal(await orchestrator.handle('Chuyện hôm nay thế nào?', options('repair-chat')), null);
  assert.equal(repairCalls, 2);
  adapters.dispatchToProvider = dispatchMock;
  answer = { templateId: 'invented/lookup', inputs: {}, evidence: {} };
  assert.equal(await orchestrator.handle('Yêu cầu không thuộc catalog', options('invented')), null);
  answer = { templateId: 'phase1_examples/lookup', inputs: { code: 'NOT_IN_USER_MESSAGE' }, evidence: { code: 'made-up-quote' } };
  response = await orchestrator.handle('Tra cứu đối tượng', options('evidence'));
  assert.equal(response.execution.status, 'WAITING_INPUT'); assert.equal(response.execution.inputs.code, undefined);
  answer = { intent: 'workflow', templateId: 'phase1_examples/lookup', inputs: {}, evidence: {} };
  response = await orchestrator.handle('Xin thực hiện nghiệp vụ tìm hồ sơ nhưng chưa có mã', options('semantic-missing'));
  assert.equal(response.execution.status, 'WAITING_INPUT');
  assert.equal(response.execution.missingInputs[0].key, 'code');
  answer = { intent: 'workflow', templateId: 'phase1_examples/lookup', inputs: {}, evidence: {}, scopeMatches: false };
  assert.equal(await orchestrator.handle('Tra cứu một nghiệp vụ khác ngoài phạm vi mẫu', options('wrong-scope')), null);
  answer = { intent: 'chat', templateId: null, inputs: {}, evidence: {} };
  for (const message of ['hello', 'Xin chào bạn', 'hi', 'cảm ơn']) {
    assert.equal(await orchestrator.handle(message, options('greeting-new')), null);
    assert.equal(await orchestrator.handle(message, options('evidence')), null);
  }
  assert.equal((await automation.runtime.pending(admin, 'evidence')).input.code, undefined);
  answer = { intent: 'chat', chatKind: 'social', replyText: 'Xin chào! Bạn cần hỗ trợ gì?', templateId: null, inputs: {}, evidence: {} };
  for (const session of ['social-new', 'evidence']) {
    const before = adapters.dispatchToProvider.mock.callCount();
    const social = await orchestrator.handle('hi', options(session));
    assert.equal(social.replyText, answer.replyText);
    assert.equal(social.executionMode, 'chat');
    assert.equal(social.execution, undefined);
    assert.equal(social.tokenUsage.calls, 1);
    assert.equal(adapters.dispatchToProvider.mock.callCount() - before, 1);
  }
  assert.equal((await automation.runtime.pending(admin, 'evidence')).status, 'WAITING_INPUT');
  answer = { intent: 'chat', templateId: null, inputs: {}, evidence: {} };
  assert.equal(await orchestrator.handle('Giải thích thuyết tương đối', options('unrelated')), null);
  answer = { templateId: null, inputs: {}, evidence: {} };
  assert.equal(await orchestrator.handle('Tra cứu đối tượng', options('abstain')), null);
  answer = { intent: 'slot_answer', templateId: 'phase1_examples/lookup', inputs: { code: 'A002' }, evidence: { code: 'A002' } };
  response = await orchestrator.handle('A002', options('evidence'));
  assert.equal(response.execution.status, 'READY'); assert.equal(response.execution.inputs.code, 'A002');
  answer = { intent: 'cancel', templateId: null, inputs: {}, evidence: {} };
  response = await orchestrator.handle('Hủy tác vụ', options('evidence'));
  assert.equal(response.execution.status, 'CANCELLED');
  t.mock.method(adapters, 'dispatchToProvider', async () => { throw new Error('Unavailable model'); });
  assert.equal(await orchestrator.handle('hello', options('offline-new')), null);
  response = await orchestrator.handle('Tra cứu đối tượng', options('baseline'));
  assert.equal(response.execution.status, 'WAITING_INPUT');
  assert.equal(await orchestrator.handle('hello', options('baseline')), null);
  assert.equal(await orchestrator.handle('A003', options('baseline')), null);
  assert.equal((await automation.runtime.pending(admin, 'baseline')).input.code, undefined);
  // A close lexical match asks the user to select instead of executing under a negation.
  response = await orchestrator.handle('không tra cứu đối tượng', options('negated'));
  assert.equal(response.execution.status, 'SELECT_TEMPLATE');
});
