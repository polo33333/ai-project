'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const governance = require('../src/backend/governance/context');
const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
const { defaultToolManager } = require('../src/backend/agent_core');
const { memory } = require('../src/backend/memory_core/durable_memory');
const memoryNames = ['recall_memory', 'remember_preference', 'forget_memory'];

test('agent saves an explicitly requested preference with server-owned identity and can recall it across sessions', () => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:memory-agent-owner', role: 'user', channel: 'chat' });
  const question = 'Please remember: I prefer short answers.';
  let calls = 0;
  const harness = new Harness({ toolManager: defaultToolManager, dispatch: async () => ++calls === 1
    ? { tool_calls: [{ id: 'remember', type: 'function', function: { name: 'remember_preference', arguments: JSON.stringify({ title: 'Response length', content: 'Prefer short answers.', quote: question }) } }] }
    : { content: 'I will remember your preference for short answers.' } });
  const result = await harness.run({ userMessage: question, provider: { id: 'fixture', name: 'Fixture', executionClass: 'remote', supportsToolCalling: true },
    messages: [{ role: 'user', content: question }], enabledToolNames: memoryNames,
    context: { governedController: true, session: { id: 'first-session', accountId: 'memory-agent-owner' }, permissions: [] } });
  assert.ok(result.toolCalls.some(item => item.toolName === 'remember_preference' && item.success));
  const saved = memory.list({ scope: 'personal' }).items[0];
  assert.equal(saved.owner, 'account:memory-agent-owner');
  assert.ok(memory.context()[0].content.includes('Prefer short answers.'));
  assert.equal((await require('../src/backend/memory_core/tools').execute('recall_memory', { query: 'short' }, { session: { id: 'second-session' } })).items[0].id, saved.id);
  await require('../src/backend/memory_core/tools').execute('forget_memory', { id: saved.id, revision: saved.revision, quote: 'forget this' }, { userMessage: 'Please forget this preference' });
  assert.equal(memory.list().items.length, 0);
}));

test('embed never receives durable memory tools even in an admin preview', () => governance.run(() => {
  governance.setPrincipal({ subject: 'embed:widget:origin', role: 'admin', channel: 'embed', embedId: 'widget' });
  const defs = defaultToolManager.getToolDefinitions({ permissions: ['admin'], allowedToolNames: memoryNames });
  assert.deepEqual(defs, []);
  const legacyDefs = require('../src/backend/intelligent_core/tool_registry').listTools(memoryNames, { permissions: ['admin'] });
  assert.deepEqual(legacyDefs, []);
}));
