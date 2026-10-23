'use strict';
// HARNESS_PIPELINE=v2 end-to-end through GuardedAgentHarness with fixture
// metadata, workflows and SQL results (no provider, no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const table = { tableId: 's::testrows', tableName: 'TestRows', schemaName: 'dbo', dbSourceId: 's', isActive: true,
  defaultTimeColumn: 'DocDate', semanticModel: { entity: 'Sản lượng', summaryFields: ['ID'], monetaryFields: ['Amount'] },
  columns: [{ columnName: 'ID', dataType: 'INT', isPrimaryKey: true, displayName: 'ID' }, { columnName: 'DocDate', dataType: 'DATETIME', displayName: 'Ngày' },
    { columnName: 'Qty', dataType: 'FLOAT', displayName: 'Sản lượng' }, { columnName: 'Amount', dataType: 'FLOAT', displayName: 'Thành tiền' }] };
const report = { templateId: 'test/report', name: 'Báo cáo sản lượng tháng', description: 'Sản lượng theo tháng gần nhất.', operations: ['aggregate', 'chart'],
  inputs: { months: { required: true, label: 'Số tháng', schema: { type: 'integer', minimum: 1, maximum: 24 } } } };
const call = (name, args) => ({ tool_calls: [{ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function run(t, { contracts, workflowStatus = 'WAITING_INPUT', question = 'vẽ biểu đồ sản lượng 7 tháng', rows = [] }) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [table]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), seen = { sql: [], runs: [], charts: [], exports: [] };
  const register = (name, run) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = run; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['TestRows'], tableDirectory: [{ tableName: 'TestRows' }],
    intentCatalog: [{ tableName: 'TestRows', columns: [] }], tables: [] }));
  register('list_workflows', async () => ({ workflows: [report] }));
  register('run_workflow', async (args, context) => {
    await context.assessWorkflow({ id: args.templateId }, args.inputs);
    seen.runs.push(args);
    return { runId: 'run-1', execution: { id: 'run-1', status: workflowStatus, name: report.name, missingInputs: [] } };
  });
  register('execute_sql_query', async args => { seen.sql.push(args.sql); return { sql: args.sql, rows }; });
  register('render_chart', async args => { seen.charts.push(args); return { chartSpec: { type: args.type, data: { labels: args.labels } } }; });
  register('export_data', async args => { seen.exports.push(args); return { downloadUrl: '/api/exports/file.xlsx', fileName: 'file.xlsx' }; });
  const pending = [...contracts];
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, _messages, definitions) => {
    const name = definitions[0]?.function?.name;
    if (name === 'plan_query') return call('plan_query', pending.shift());
    if (name === 'assess_workflow') return call('assess_workflow', { suitable: true, reason: 'exact', confirmedSlots: ['months'] });
    return { content: 'fallback' };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query', 'list_workflows', 'run_workflow', 'render_chart', 'export_data'],
    context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } } } });
  return { result, seen };
}

test('v2 starts an exactly matching workflow with question-grounded inputs only', async t => {
  const { result, seen } = await run(t, { contracts: [{ kind: 'workflow', workflow: { templateId: 'test/report',
    inputs: { months: '7', invented: 'x' }, evidence: { months: '7 tháng', invented: 'x' } } }] });
  assert.deepEqual(seen.runs, [{ templateId: 'test/report', inputs: { months: 7 } }]);
  assert.equal(seen.sql.length, 0);
  assert.equal(result.trace.pipeline, 'v2');
  assert.ok(result.trace.steps.some(step => step.type === 'WORKFLOW_TOOL_HANDOFF'));
  assert.match(result.replyText, /Báo cáo sản lượng tháng/);
});

test('a failed workflow falls back to a data contract with a chart built from the same rows', async t => {
  const rows = [{ 'Tháng': new Date('2025-01-01T00:00:00Z'), 'Tổng Sản lượng': 10 }, { 'Tháng': new Date('2025-02-01T00:00:00Z'), 'Tổng Sản lượng': 12 }];
  const { result, seen } = await run(t, { workflowStatus: 'FAILED', rows, contracts: [
    { kind: 'workflow', workflow: { templateId: 'test/report', inputs: { months: '7' }, evidence: { months: '7 tháng' } } },
    { kind: 'data', root: 'TestRows', operation: 'aggregate', measures: [{ ref: 'Qty', aggregation: 'SUM' }],
      groupBy: [{ ref: 'TestRows.DocDate', grain: 'month' }], output: { chart: 'line' } }] });
  assert.equal(seen.runs.length, 1);
  assert.equal(seen.sql.length, 1);
  assert.deepEqual(seen.charts[0].labels, ['2025-01', '2025-02']);
  assert.deepEqual(seen.charts[0].datasets, [{ label: 'Tổng Sản lượng', data: [10, 12] }]);
  assert.ok(result.toolCalls.every(item => item.toolName !== 'run_workflow'), 'a failed run is not presented as the answer');
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('an export request writes every verified row and links the file', async t => {
  const rows = [{ ID: 1, 'Ngày': '2025-01-03', 'Thành tiền': 5 }, { ID: 2, 'Ngày': '2025-01-04', 'Thành tiền': 7 }];
  const { result, seen } = await run(t, { question: 'xuất file excel danh sách', rows, contracts: [
    { kind: 'data', root: 'TestRows', operation: 'list', output: { export: 'xlsx' } }] });
  assert.match(seen.sql[0], /^SELECT TOP 1000 /);
  assert.equal(seen.exports[0].data.length, 2);
  assert.equal(seen.exports[0].format, 'xlsx');
  assert.match(result.replyText, /\/api\/exports\/file\.xlsx/);
});
