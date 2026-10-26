'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const governance = require('../src/backend/governance/context');
const core = require('../src/backend/intelligent_core/core');
const memory = require('../src/backend/memory_core').memoryService;
test('explicit web search isolates internal resources, memory, history and tool capabilities', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:admin', role: 'admin' });
  governance.read({ id: 'internal', name: 'IPMS', governedPolicy: { modelDestinations: [] } }, 'sql');
  const provider = { id: 'web-provider', model: 'fixture', name: 'Web' };
  t.mock.method(require('../src/backend/services/ai_provider_manager'), 'getActiveProvider', () => provider);
  for (const method of ['getLegacyContext', 'getSession', 'getContext', 'getResolutionContext']) t.mock.method(memory, method, () => { throw new Error('Web must never read memory'); });
  t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'buildSchemaContext', () => { throw new Error('Web must never read schema'); });
  t.mock.method(require('../src/backend/services/web_search_service'), 'search', async query => {
    assert.equal(query, 'public question');
    assert.equal(governance.current().resources.size, 0);
    assert.equal(governance.principal().subject, 'account:admin');
    return [{ title: 'Public source', url: 'https://example.com/source', snippet: 'Verified public information' }];
  });
  t.mock.method(require('../src/backend/intelligent_core/adapters'), 'dispatchToProvider', async (_, messages, tools) => {
    assert.deepEqual(tools, []);
    assert.equal(messages.length, 2);
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_IPMS_VALUE'));
    assert.equal(governance.current().resources.size, 0);
    return { content: 'Verified public information [Nguồn](https://example.com/source)', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
  });
  const result = await core.chat('public question', { webSearch: true, dbSourceId: 'internal', history: [{ role: 'user', content: 'PRIVATE_IPMS_VALUE' }], session: { id: 'old-ipms', accountId: 'admin' } });
  assert.equal(result.contextSelection.dbSourceId, null);
  assert.equal(result.trace.memoryDecision.reason, 'independent_web_search');
  assert.equal(result.tokenUsage.calls, 1);
  assert.equal(governance.current().resources.size, 1, 'Parent governance scope must remain intact.');
  assert.equal(memory.persistSuccessfulExchange({ currentPlan: result.trace.training.plan }).persisted, false);
  assert.equal(memory.recordPendingTurn({ currentPlan: result.trace.training.plan }).recorded, false);
}));

test('unavailable web search does not call model or fall back to internal data', async t => {
  t.mock.method(require('../src/backend/services/ai_provider_manager'), 'getActiveProvider', () => ({ id: 'web', model: 'fixture' }));
  t.mock.method(require('../src/backend/services/web_search_service'), 'search', async () => { throw new Error('Web search HTTP 429'); });
  const dispatch = t.mock.method(require('../src/backend/intelligent_core/adapters'), 'dispatchToProvider', () => { throw new Error('Must not dispatch'); });
  const result = await core.chat('public question', { webSearch: true });
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(result.contextSelection.webSearch.error, 'Web search HTTP 429');
  assert.equal(dispatch.mock.callCount(), 0);
  assert.equal(result.tokenUsage, null);
});
