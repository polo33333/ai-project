'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('an empty slot classification reviews the request and reuses the matching pending run', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  const definition = { id: 'report/sales', name: 'Report', inputs: {} };
  const run = { id: 'existing', templateId: definition.id, definition, status: 'WAITING_INPUT', input: {}, missing: [], revision: 1 };
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [definition]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(automation.runtime, 'pending', async () => run);
  t.mock.method(automation.runtime, 'view', value => ({ id: value.id, name: 'Report', status: value.status, missingInputs: [] }));
  const create = t.mock.method(automation.runtime, 'create', async () => { throw Error('Must not duplicate'); });
  const update = t.mock.method(automation.runtime, 'inputs', async () => { throw Error('No confirmed input'); });
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
    const context = JSON.parse(messages[1].content);
    return { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 }, content: JSON.stringify(messages[0].content.startsWith('Verify business scope')
      ? { matches: true, evidence: 'Sales report', requestedScope: 'aggregate', supportedScope: 'aggregate' }
      : { intent: context.current ? 'slot_answer' : 'workflow', templateId: definition.id, inputs: {}, evidence: {} }) };
  });
  const result = await handle('Sales report', { session: { accountId: 'user', id: 'chat' } });
  assert.equal(result.execution.id, run.id);
  assert.equal(result.tokenUsage.calls, 3);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

test('a standalone parameterized request never updates the older waiting form', async t => {
  const automation = require('../src/backend/automation');
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { handle } = require('../src/backend/automation/orchestrator');
  const definition = { id: 'report/sales', name: 'Report', inputs: { months: { required: true, schema: { type: 'integer' } } } };
  const old = { id: 'old-run', templateId: definition.id, definition, status: 'WAITING_INPUT', input: {}, missing: [{ key: 'months' }], revision: 1 };
  const question = 'Generate a report for 7 months';
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [definition]);
  t.mock.method(automation.registry, 'match', async () => ({ candidates: [] }));
  t.mock.method(automation.runtime, 'pending', async () => old);
  const update = t.mock.method(automation.runtime, 'inputs', async () => { throw Error('Must not update old form'); });
  t.mock.method(automation.runtime, 'create', async (id, inputs, context, options) => {
    assert.equal(id, definition.id);
    assert.deepEqual(inputs, { months: 7 });
    assert.equal(options.separateRequest, true);
    assert.equal(options.preservePending, true);
    return { id: 'new-run', name: 'Report', status: 'READY' };
  });
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
    const context = JSON.parse(messages[1].content), prompt = messages[0].content;
    const value = prompt.startsWith('Verify pending workflow') ? { requestKind: 'new_request', confirmedSlots: [] }
      : prompt.startsWith('Verify business scope') ? { matches: true, evidence: question, requestedScope: 'aggregate', supportedScope: 'aggregate' }
      : { intent: context.current ? 'slot_answer' : 'workflow', templateId: definition.id, inputs: { months: 7 }, evidence: { months: '7' } };
    return { content: JSON.stringify(value) };
  });
  const result = await handle(question, { session: { accountId: 'user', id: 'chat' } });
  assert.equal(result.execution.id, 'new-run');
  assert.equal(update.mock.callCount(), 0);
  assert.equal(old.status, 'WAITING_INPUT');
  assert.deepEqual(old.input, {});
});
