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
