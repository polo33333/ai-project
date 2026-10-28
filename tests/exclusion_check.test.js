'use strict';
// "trừ X" on a column that does not hold X removes nothing yet looks applied;
// the exclusion moves to the column of the same table that holds X, or the
// answer says nothing was excluded.
const test = require('node:test');
const assert = require('node:assert/strict');

async function run(t, filter, stored) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  const table = { tableId: 's::staff', tableName: 'Staff', schemaName: 'dbo', dbSourceId: 's', isActive: true,
    columns: [{ columnName: 'ID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'StaffCode', dataType: 'NVARCHAR', displayName: 'Mã NV' },
      { columnName: 'StaffName', dataType: 'NVARCHAR', displayName: 'Tên NV' }] };
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [table]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent/tools/base_tool');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const manager = new Manager(), queries = [];
  const register = (name, handler) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = handler; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['Staff'], tableDirectory: [{ tableName: 'Staff' }], intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => {
    const probe = args.sql.match(/WHERE \[(\w+)\] = N'([^']*)'/);
    if (/AS \[hit\]/.test(args.sql)) return { sql: args.sql, rows: stored[probe[1]]?.includes(probe[2]) ? [{ hit: 1 }] : [] };
    queries.push(args.sql);
    return { sql: args.sql, rows: [{ 'Mã NV': 'NV001', 'Tên NV': 'An' }] };
  });
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, _messages, definitions) => definitions[0]?.function?.name === 'plan_query'
    ? { tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify({ kind: 'data', root: 'Staff', operation: 'list', filters: [filter] }) } }] }
    : { content: 'ok' } });
  const result = await harness.run({ userMessage: 'Danh sách nhân viên trừ Demo3', provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'], context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } } } });
  return { result, queries };
}

test('an exclusion on the wrong column moves to the column that holds the value', async t => {
  const { result, queries } = await run(t, { ref: 'Staff.StaffCode', operator: 'ne', value: 'Demo3', evidence: 'trừ Demo3' },
    { StaffCode: ['NV001', 'NV003'], StaffName: ['An', 'Demo3'] });
  assert.match(queries.at(-1), /\[StaffName\] <> N'Demo3'/);
  assert.doesNotMatch(queries.at(-1), /\[StaffCode\] <> /);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_EXCLUSION_MOVED' && step.to === 'StaffName'));
});

test('an exclusion whose value is stored nowhere is reported, not silently applied', async t => {
  const { result } = await run(t, { ref: 'Staff.StaffName', operator: 'ne', value: 'Demo3', evidence: 'trừ Demo3' }, { StaffCode: [], StaffName: ['An'] });
  assert.match(result.replyText, /Không tìm thấy “Demo3” trong dữ liệu nên không có bản ghi nào bị loại trừ/);
});

test('an exclusion on the right column is left alone', async t => {
  const { result, queries } = await run(t, { ref: 'Staff.StaffName', operator: 'ne', value: 'Demo3', evidence: 'trừ Demo3' }, { StaffName: ['Demo3'] });
  assert.match(queries.at(-1), /\[StaffName\] <> N'Demo3'/);
  assert.equal(result.trace.steps.some(step => /^V2_EXCLUSION/.test(step.type)), false);
});
