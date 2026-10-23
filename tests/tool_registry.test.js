const test = require('node:test');
const assert = require('node:assert/strict');
const toolRegistry = require('../src/backend/intelligent_core/tool_registry');
const sqlConnector = require('../src/backend/services/sql_connector');
const { ExecuteSqlTool } = require('../src/backend/agent_core/tools/builtins');

test('tool registry can expose only selected general-purpose tools', () => {
  const names = toolRegistry
    .getOpenAiToolsFormat(['get_current_datetime', 'calculate_expression', 'calculate_stats'])
    .map(tool => tool.function.name);

  assert.deepEqual(names, ['get_current_datetime', 'calculate_stats', 'calculate_expression']);
});

test('datetime tool returns a Vietnamese weekday', async () => {
  const response = await toolRegistry.executeTool('get_current_datetime', {
    timezone: 'Asia/Ho_Chi_Minh'
  });

  assert.equal(response.success, true);
  assert.match(response.result.weekday, /^Thứ (Hai|Ba|Tư|Năm|Sáu|Bảy)$|^Chủ Nhật$/i);
  assert.match(response.result.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('calculation tool evaluates a simple arithmetic expression', async () => {
  const response = await toolRegistry.executeTool('calculate_expression', {
    expression: '43 + 343'
  });

  assert.equal(response.success, true);
  assert.equal(response.result.value, 386);
  assert.equal(response.envelope.status, 'succeeded');
  assert.equal(response.envelope.data, response.result);
});

test('direct registry calls preserve rejection metadata and never dispatch after deadline', async t => {
  let calls = 0;
  t.mock.method(toolRegistry, 'executeLegacyTool', async () => { calls++; return { success: true, result: {} }; });
  const disabled = await toolRegistry.executeTool('calculate_expression', { expression: '1+1' }, { allowedToolNames: [] });
  assert.equal(disabled.envelope.status, 'denied');
  assert.equal(disabled.envelope.error.code, 'TOOL_NOT_ENABLED');
  const expired = await toolRegistry.executeTool('calculate_expression', { expression: '1+1' }, { executionBudget: { remainingMs: () => 0 } });
  assert.equal(expired.envelope.status, 'timeout');
  const controller = new AbortController(); controller.abort();
  assert.equal((await toolRegistry.executeTool('calculate_expression', {}, { signal: controller.signal })).envelope.status, 'cancelled');
  assert.equal(calls, 0);
});

test('schema tool wrapper preserves registry denial code and outcome', async t => {
  const { SearchSchemaTool } = require('../src/backend/agent_core/tools/builtins');
  const ToolManager = require('../src/backend/agent_core/tools/tool_manager');
  t.mock.method(toolRegistry, 'executeTool', async () => ({ success: false, error: 'Source denied',
    code: 'SOURCE_DENIED', outcome: 'denied', effectState: 'none' }));
  const manager = new ToolManager(); manager.registerTool(new SearchSchemaTool());
  const result = await manager.executeTool('search_schema', { query: 'records' });
  assert.equal(result.envelope.status, 'denied');
  assert.equal(result.envelope.error.code, 'SOURCE_DENIED');
  assert.equal(result.envelope.effectState, 'none');
});

test('SQL tool forwards the selected database source from tool context', async () => {
  const original = sqlConnector.executeSqlQuery;
  let receivedSourceId = null;
  sqlConnector.executeSqlQuery = async (_sql, sourceId) => {
    receivedSourceId = sourceId;
    return [{ total: 1 }];
  };
  try {
    const response = await new ExecuteSqlTool().execute(
      { sql: 'SELECT 1 AS total' },
      { permissions: ['sql:read'], dbSourceId: 'db-src-test' }
    );
    assert.equal(response.success, true);
    assert.equal(receivedSourceId, 'db-src-test');
  } finally {
    sqlConnector.executeSqlQuery = original;
  }
});

test('SQL tool rejects JOIN execution without a backend plan when planner is enabled', async t => {
  const previous = process.env.SQL_JOIN_PLANNER_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.SQL_JOIN_PLANNER_ENABLED; else process.env.SQL_JOIN_PLANNER_ENABLED = previous; });
  process.env.SQL_JOIN_PLANNER_ENABLED = 'true';
  const dictionary = require('../src/backend/services/dictionary_service');
  const oldSources = sqlConnector.dbSources, oldTables = dictionary.tablesStore, oldRelations = dictionary.tableRelationships;
  t.after(() => { sqlConnector.dbSources = oldSources; dictionary.tablesStore = oldTables; dictionary.tableRelationships = oldRelations; });
  sqlConnector.dbSources = [{ id: 'db-src-test', dbName: 'TEST' }];
  const { withIdentity } = require('../src/backend/services/schema_identity');
  dictionary.tablesStore = ['Orders', 'Customers'].map(tableName => withIdentity({ dbSourceId: 'db-src-test', dbName: 'TEST', schemaName: 'dbo', tableName, isActive: true, columns: [{ columnName: 'ID' }, { columnName: 'CustomerID' }] }));
  dictionary.tableRelationships = [];

  const response = await new ExecuteSqlTool().execute(
    { sql: 'SELECT o.ID FROM Orders o JOIN Customers c ON o.CustomerID = c.ID' },
    { permissions: ['sql:read'], dbSourceId: 'db-src-test' }
  );
  assert.equal(response.success, false);
  assert.match(response.error, /không có backend JOIN plan/);
});
