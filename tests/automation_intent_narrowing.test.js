// Compatibility coverage for the pre-flag API; current routing is covered by chat_router.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('selected provider narrows all authorized templates before detailed routing', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  const provider = { id: 'third-party', baseUrl: 'http://fixture.invalid', model: 'fixture' };
  t.mock.method(providers, 'getProviderForExecution', id => { assert.equal(id, provider.id); return provider; });
  const definitions = Array.from({ length: 60 }, (_, i) => ({ id: `operation-${i}`, name: `Operation ${i}`, description: `Business operation ${i}`, inputs: {} }));
  const target = definitions[59].id;
  const stages = [];
  t.mock.method(adapters, 'dispatchToProvider', async (selected, messages) => {
    assert.equal(selected.id, provider.id);
    const context = JSON.parse(messages[1].content);
    if (messages[0].content.startsWith('Identify the meaning')) {
      stages.push('narrow');
      assert.ok(context.candidates.some(item => item.id === target));
      return { content: JSON.stringify({ intent: 'Requested business operation', scope: 'targeted', candidateIds: [target] }) };
    }
    if (messages[0].content.startsWith('Verify business scope')) {
      stages.push('verify');
      return { content: JSON.stringify({ matches: true, evidence: 'requested operation', requestedScope: 'targeted', supportedScope: 'targeted' }) };
    }
    stages.push('classify');
    assert.deepEqual(context.catalog.map(item => item.id), [target]);
    assert.equal(context.intentAssessment.scope, 'targeted');
    return { content: JSON.stringify({ intent: 'workflow', templateId: target, inputs: {}, evidence: {} }) };
  });
  const response = await interpret('requested operation', definitions, null, { providerId: provider.id });
  assert.equal(response.templateId, target);
  assert.deepEqual(stages, ['narrow', 'classify', 'verify']);
});

test('large catalogs are batched and shortlisted candidates are reduced to five', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'local', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const definitions = Array.from({ length: 24 }, (_, i) => ({ id: `task-${i}`, name: `Task ${i}`, description: 'Business description '.repeat(40), inputs: {} }));
  let shortlistCalls = 0;
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
    const context = JSON.parse(messages[1].content);
    if (messages[0].content.startsWith('Identify the meaning')) {
      shortlistCalls++;
      assert.ok(messages[1].content.length <= 16000);
      return { content: JSON.stringify({ intent: 'Business request', scope: 'targeted', candidateIds: context.candidates.slice(0, 5).map(item => item.id) }) };
    }
    if (messages[0].content.startsWith('Verify business scope')) return { content: JSON.stringify({ matches: true, evidence: 'business request', requestedScope: 'targeted', supportedScope: 'targeted' }) };
    assert.ok(context.catalog.length <= 5);
    return { content: JSON.stringify({ intent: 'workflow', templateId: context.catalog[0].id, inputs: {}, evidence: {} }) };
  });
  const response = await interpret('business request', definitions, null, {});
  assert.ok(response.templateId);
  assert.ok(shortlistCalls >= 3);
});

test('collection intent cannot be reinterpreted as targeted or pass incomplete scope verification', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'remote', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const definitions = ['lookup', 'other'].map(id => ({ id, name: id, inputs: {} }));
  for (const verification of [
    { matches: true, requestedScope: 'targeted', supportedScope: 'targeted' },
    { matches: true, requestedScope: 'collection', supportedScope: 'targeted' },
    { matches: true, requestedScope: 'collection' }
  ]) {
    const events = [];
    t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => {
      const prompt = messages[0].content;
      if (prompt.startsWith('Identify the meaning')) return { content: JSON.stringify({ intent: 'List contracts', scope: 'collection', candidateIds: ['lookup'] }) };
      if (prompt.startsWith('Verify business scope')) return { content: JSON.stringify({ ...verification, evidence: 'ds h\u0111' }) };
      return { content: JSON.stringify({ intent: 'workflow', templateId: 'lookup', inputs: {}, evidence: {} }) };
    });
    const result = await interpret('ds h\u0111', definitions, null, { onWorkflowRouting: event => events.push(event) });
    assert.equal(result.templateId, null);
    assert.ok(['scope_conflict', 'scope_rejected'].includes(events.at(-1).reason));
  }
});

test('invalid or empty shortlists do not proceed to detailed routing', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'selected', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const definitions = ['first', 'second'].map(id => ({ id, name: id, inputs: {} }));
  for (const candidateIds of [[], ['invented']]) {
    let calls = 0;
    t.mock.method(adapters, 'dispatchToProvider', async () => { calls++; return { content: JSON.stringify({ intent: 'Other request', scope: 'unclear', candidateIds }) }; });
    const response = await interpret('another request', definitions, null, {});
    assert.equal(response.templateId, null);
    assert.equal(calls, 1);
  }
});
