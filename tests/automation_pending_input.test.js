'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('unrelated messages never update a waiting workflow even when classification extracts a valid string', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  const slot = { label: 'Employee identifier', ask: 'Which employee?', required: true, schema: { type: 'string' } };
  const definition = { id: 'employee/lookup', name: 'Employee details', description: 'Find an employee', inputs: { query: slot } };
  const pending = { id: 'waiting', templateId: definition.id, definition, status: 'WAITING_INPUT', input: {}, missing: [{ key: 'query', ...slot }], revision: 1 };
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [definition]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(automation.runtime, 'pending', async () => pending);
  const update = t.mock.method(automation.runtime, 'inputs', async (_, values) => ({ status: 'READY', inputs: values }));
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'selected', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  let question, confirmed = false;
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Verify pending workflow') ? { requestKind: 'slot_answer', confirmedSlots: confirmed ? ['query'] : [] } : !JSON.parse(messages[1].content).current ? { intent: 'chat', templateId: null, inputs: {} } : { intent: 'slot_answer', templateId: definition.id, inputs: { query: question }, evidence: { query: question } }) }));
  const options = { session: { accountId: 'user', id: 'conversation' } };
  for (question of ['What is the weather?', 'List customers', 'Explain this system']) {
    assert.equal(await handle(question, options), null);
  }
  assert.equal(update.mock.callCount(), 0);
  assert.equal(pending.status, 'WAITING_INPUT');
  assert.deepEqual(pending.input, {});
  question = 'NV001'; confirmed = true;
  const response = await handle(question, options);
  assert.equal(update.mock.callCount(), 1);
  assert.equal(response.execution.status, 'READY');
  assert.deepEqual(response.execution.inputs, { query: 'NV001' });
});

test('routing usage reaches the core collector even when no workflow is chosen', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.runtime, 'pending', async () => null);
  t.mock.method(automation.registry, 'list', async () => [{ id: 'one', name: 'One', inputs: {} }, { id: 'two', name: 'Two', inputs: {} }]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const usage = { inputTokens: 200, outputTokens: 30, totalTokens: 230, calls: 1 };
  t.mock.method(adapters, 'dispatchToProvider', async () => ({ usage, content: JSON.stringify({ intent: 'Unrelated data request', scope: 'collection', candidateIds: [] }) }));
  const collected = [];
  assert.equal(await handle('List other data', { session: { accountId: 'user', id: 'conversation' }, onWorkflowUsage: value => collected.push(value) }), null);
  assert.deepEqual(collected, [usage]);
});

test('a new business topic searches the catalog while preserving the waiting task', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  const old = { id: 'old/lookup', name: 'Old lookup', inputs: {} };
  const report = { id: 'new/report', name: 'New report', inputs: {} };
  const pending = { id: 'waiting', templateId: old.id, definition: old, status: 'WAITING_INPUT', input: {}, missing: [], revision: 1 };
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [old, report]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(automation.runtime, 'pending', async () => pending);
  const cancel = t.mock.method(automation.runtime, 'cancel', async () => { throw Error('Must preserve old task'); });
  const update = t.mock.method(automation.runtime, 'inputs', async () => { throw Error('Must not update old task'); });
  const create = t.mock.method(automation.runtime, 'create', async (id, inputs, context, options) => {
    assert.equal(id, report.id);
    assert.equal(options.preservePending, true);
    return { id: 'new-run', name: 'New report', status: 'WAITING_INPUT', missingInputs: [] };
  });
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  let invalidPendingDecision = false;
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
    const prompt = messages[0].content, data = JSON.parse(messages[1].content);
    if (data.current && invalidPendingDecision) return { content: 'invalid JSON' };
    let value;
    if (prompt.startsWith('Identify the meaning')) value = { intent: 'New report', scope: 'aggregate', candidateIds: [report.id] };
    else if (prompt.startsWith('Verify business scope')) value = { matches: true, evidence: 'New report', requestedScope: 'aggregate', supportedScope: 'aggregate' };
    else value = data.current ? { intent: 'chat', templateId: null, inputs: {} } : { intent: 'workflow', templateId: report.id, inputs: {}, evidence: {} };
    return { content: JSON.stringify(value) };
  });
  const response = await handle('New report', { session: { accountId: 'user', id: 'conversation' } });
  assert.equal(response.execution.id, 'new-run');
  assert.equal(create.mock.callCount(), 1);
  assert.equal(cancel.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
  assert.equal(pending.status, 'WAITING_INPUT');
  invalidPendingDecision = true;
  assert.equal((await handle('New report', { session: { accountId: 'user', id: 'conversation' } })).execution.id, 'new-run');
  assert.equal(create.mock.callCount(), 2);
  assert.equal(cancel.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

test('misclassified topic changes cannot cancel a pending task; explicit cancellation is verified', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  const definition = { id: 'report/sales', name: 'Sales report', inputs: {} };
  const pending = { id: 'waiting', templateId: definition.id, definition, status: 'WAITING_INPUT', input: {}, missing: [], revision: 1 };
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [definition]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(automation.runtime, 'pending', async () => pending);
  const cancel = t.mock.method(automation.runtime, 'cancel', async () => ({ ...pending, status: 'CANCELLED' }));
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  let confirmation = { confirmed: false, evidence: '' };
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Verify explicit cancellation') ? confirmation : { intent: 'cancel', templateId: null, inputs: {}, evidence: {} }) }));
  const options = { session: { accountId: 'user', id: 'conversation' } };
  for (const question of ['ds h\u0111', 'List customers', 'No chart please']) assert.equal(await handle(question, options), null);
  confirmation = { confirmed: true, evidence: 'invented cancellation quote' };
  assert.equal(await handle('Another question', options), null);
  assert.equal(cancel.mock.callCount(), 0);
  assert.equal(pending.status, 'WAITING_INPUT');
  confirmation = { confirmed: true, evidence: 'Cancel this task' };
  assert.equal((await handle('Cancel this task', options)).execution.status, 'CANCELLED');
  assert.equal(cancel.mock.callCount(), 1);
});
