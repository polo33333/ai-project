'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BaseTool = require('../src/backend/agent/tools/base_tool');
const ToolManager = require('../src/backend/agent/tools/tool_manager');
class Probe extends BaseTool {
  constructor(options = {}) { super({ name: 'probe', description: 'Test adapter', ...options }); this.calls = 0; }
  async run(args, context) { this.calls++; return { args, cancelled: context.signal.aborted }; }
}

test('restricted tools fail closed in discovery and direct execution', async () => {
  const tool = new Probe({ requiredPermissions: ['sql:read'] });
  const manager = new ToolManager(); manager.registerTool(tool);
  assert.deepEqual(manager.getToolDefinitions(), []);
  assert.deepEqual(manager.getToolDefinitions({ permissions: [] }), []);
  assert.equal((await manager.executeTool('probe', {})).success, false);
  assert.equal(tool.calls, 0);
  assert.equal(manager.getToolDefinitions({ permissions: ['sql:read'] }).length, 1);
  assert.equal((await manager.executeTool('probe', {}, { permissions: ['sql:read'] })).success, true);
});

test('JSON Schema validates nested types, bounds, composition and additional fields without coercion', async () => {
  const tool = new Probe({ parameters: { type: 'object', additionalProperties: false,
    properties: { rows: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      properties: { amount: { type: 'integer', minimum: 0, maximum: 10 } }, required: ['amount'] } },
      selector: { oneOf: [{ const: 'all' }, { type: 'integer', minimum: 1 }] } }, required: ['rows', 'selector'] } });
  for (const args of [null, [], { rows: [], selector: 'all' }, { rows: [{ amount: '2' }], selector: 'all' },
    { rows: [{ amount: 11 }], selector: 'all' }, { rows: [{ amount: 1, secret: true }], selector: 'all' },
    { rows: [{ amount: 1 }], selector: false }, { rows: [{ amount: 1 }], selector: 'all', extra: true }]) {
    assert.equal((await tool.execute(args)).success, false, JSON.stringify(args));
  }
  assert.equal(tool.calls, 0);
  assert.equal((await tool.execute({ rows: [{ amount: 0 }], selector: 'all' })).success, true);
});

test('timeout propagates to adapter and preserves unknown effects for dangerous tools', async () => {
  const tool = new Probe({ timeoutMs: 15, isDangerous: true });
  let reached = false;
  tool.run = async (_, context) => new Promise(resolve => context.signal.addEventListener('abort', () => { reached = true; resolve(null); }, { once: true }));
  const result = await tool.execute({});
  assert.equal(result.outcome, 'timeout'); assert.equal(result.effectState, 'unknown');
  assert.equal(reached, true);
});

test('client cancellation reaches adapters and pre-cancelled calls never dispatch', async () => {
  const controller = new AbortController(); const tool = new Probe();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  tool.run = async (_, context) => { started(); return new Promise(resolve => context.signal.addEventListener('abort', () => resolve(null), { once: true })); };
  const pending = tool.execute({}, { signal: controller.signal });
  await ready; controller.abort();
  assert.equal((await pending).outcome, 'cancelled');
  const never = new Probe();
  assert.equal((await never.execute({}, { signal: controller.signal })).outcome, 'cancelled');
  assert.equal(never.calls, 0);
});

test('an expired request deadline never dispatches a tool', async () => {
  const tool = new Probe({ isDangerous: true });
  const result = await tool.execute({}, { executionBudget: { remainingMs: () => 0 } });
  assert.equal(result.code, 'REQUEST_DEADLINE_EXCEEDED');
  assert.equal(result.effectState, 'none'); assert.equal(tool.calls, 0);
});

test('per-call cancellation preserves planning context writes and leaves parent signal intact', async () => {
  const parent = new AbortController(); const context = { signal: parent.signal };
  const tool = new Probe();
  tool.run = async (_, current) => { current.dataIntentPlan = { intent: 'clarify' }; return current.signal !== parent.signal; };
  assert.equal((await tool.execute({}, context)).result, true);
  assert.equal(context.dataIntentPlan.intent, 'clarify'); assert.equal(context.signal, parent.signal);
});

test('runtime embed ownership preserves authenticated synthetic identity and quarantines legacy or mismatched owners', () => {
  const { buildModel } = require('../scripts/postgres/model');
  const documents = new Map([['conversation_memory.json', { sessions: {
    correct: { id: 'correct', embedId: 'widget', accountId: 'embed:widget:nonce' },
    wrong: { id: 'wrong', embedId: 'widget', accountId: 'embed:other:nonce' },
    orphan: { id: 'orphan', accountId: 'missing-account' }
  } }]]);
  const runtime = buildModel(documents, { runtime: true }).rows.chat_sessions;
  assert.equal(runtime.find(row => row.id === 'correct').owner_scope, 'embed:widget');
  assert.equal(runtime.find(row => row.id === 'correct').account_id, null);
  assert.match(runtime.find(row => row.id === 'wrong').owner_scope, /^legacy-unowned:/);
  assert.match(runtime.find(row => row.id === 'orphan').owner_scope, /^legacy-unowned:/);
  assert.match(buildModel(documents).rows.chat_sessions.find(row => row.id === 'correct').owner_scope, /^legacy-unowned:/);
});
