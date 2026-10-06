// Compatibility coverage for the pre-flag API; current routing is covered by chat_router.test.js.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('collection requests reject targeted workflows while detail requests allow missing identifiers', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'selected', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  const definition = { id: 'contract/lookup', name: 'Lookup', description: 'Find contracts by number', inputs: { query: { required: true, label: 'Contract number', schema: { type: 'string' } } } };
  for (const [question, scope] of [['ds hđ', 'collection'], ['chi tiết hđ', 'targeted'], ['Tra cứu hợp đồng', 'targeted']]) {
    t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Verify business scope') ? { matches: true, evidence: question, requestedScope: scope, supportedScope: 'targeted' } : { intent: 'workflow', templateId: definition.id, inputs: {}, evidence: {} }) }));
    const response = await interpret(question, [definition], null, {});
    assert.equal(response.templateId, scope === 'targeted' ? definition.id : null);
  }
});

test('abbreviated data requests cannot return a social reply', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const adapters = require('../src/backend/intelligent_core/adapters');
  const { interpretLegacy: interpret } = require('../src/backend/automation/orchestrator');
  t.mock.method(providers, 'getProviderForExecution', () => ({ id: 'selected', baseUrl: 'http://fixture.invalid', model: 'fixture' }));
  t.mock.method(adapters, 'dispatchToProvider', async (_, messages) => ({ content: JSON.stringify(messages[0].content.startsWith('Independently verify') ? { social: false } : { intent: 'chat', chatKind: 'social', templateId: null, inputs: {}, replyText: 'Which employee?' }) }));
  const response = await interpret('ds nv', [], null, {});
  assert.equal(response.replyText, undefined);
  assert.equal(response.newTopic, true);
});
