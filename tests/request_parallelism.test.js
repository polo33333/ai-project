'use strict';
// Independent read-only work in one request runs concurrently; results are
// still recorded in request order.
const test = require('node:test');
const assert = require('node:assert/strict');

function groupHarness(t, delays) {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), seen = { active: 0, peak: 0, executed: [] };
  const tool = new Base({ name: 'execute_sql_query', description: 'sql', parameters: { type: 'object', properties: { sql: { type: 'string' } } } });
  tool.run = async args => {
    seen.active++; seen.peak = Math.max(seen.peak, seen.active);
    await new Promise(resolve => setTimeout(resolve, delays.shift() ?? 10));
    seen.active--; seen.executed.push(args.sql);
    return { sql: args.sql, rows: [{ ID: 1 }], rowCount: 1 };
  };
  manager.registerTool(tool);
  const harness = new Harness({ toolManager: manager, dispatch: async () => ({ content: 'Nhóm A có 1 bản ghi, nhóm B có 1 bản ghi.' }) });
  const run = groups => harness.run({ userMessage: 'danh sách tách 2 nhóm', provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['execute_sql_query'], context: { lockProvider: true, dbSourceId: 's',
      requestPlan: { outputs: { data: true }, intent: 'list', semanticGroups: groups } } });
  return { run, seen };
}

test('result groups run concurrently and are recorded in group order', async t => {
  // The first group is slower, so it finishes last.
  const { run, seen } = groupHarness(t, [40, 5]);
  const result = await run([{ label: 'A', sql: 'SELECT ID FROM TestRows WHERE ID = 1' }, { label: 'B', sql: 'SELECT ID FROM TestRows WHERE ID = 2' }]);
  assert.equal(seen.peak, 2);
  assert.deepEqual(seen.executed, ['SELECT ID FROM TestRows WHERE ID = 2', 'SELECT ID FROM TestRows WHERE ID = 1']);
  assert.deepEqual(result.toolCalls.map(call => call.args.sql), ['SELECT ID FROM TestRows WHERE ID = 1', 'SELECT ID FROM TestRows WHERE ID = 2']);
  assert.deepEqual(result.toolCalls.map(call => call.semanticGroup), [0, 1]);
  assert.ok(result.trace.steps.some(step => step.type === 'RESULT_GROUPS_PARALLEL' && step.count === 2));
});

test('a group that fails its checks is not executed while the others are', async t => {
  const { run, seen } = groupHarness(t, []);
  const sql = 'SELECT ID FROM TestRows WHERE ID = 1';
  const result = await run([{ label: 'A', sql }, { label: 'B', sql }]);
  assert.deepEqual(seen.executed, [sql]);
  assert.deepEqual(result.toolCalls.map(call => [call.success, call.code || null]), [[true, null], [false, 'NO_PROGRESS']]);
});
