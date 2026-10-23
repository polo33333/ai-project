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

async function runForm(t, { contracts = [], answers = [], context = {}, enabledToolNames, question, rows = [], pendingInput = null }) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [{ ...table,
    columns: [...table.columns, { columnName: 'Dept', dataType: 'NVARCHAR', displayName: 'Phòng' }] }]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  t.mock.method(require('../src/backend/governance/workflow_tools'), 'pendingInput', async () => pendingInput);
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), seen = { resumes: [], exports: [] };
  const register = (name, run) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = run; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['TestRows'], tableDirectory: [{ tableName: 'TestRows' }], intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => ({ sql: args.sql, rows }));
  register('resume_workflow', async args => { seen.resumes.push(args); return { runId: args.runId, execution: { id: args.runId, status: 'SUCCEEDED', name: 'Báo cáo' } }; });
  register('export_data', async args => { seen.exports.push(args); return { downloadUrl: `/api/exports/${args.filename}.xlsx` }; });
  const pendingContracts = [...contracts], pendingAnswers = [...answers];
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, _messages, definitions) => {
    if (definitions[0]?.function?.name === 'plan_query') return call('plan_query', pendingContracts.shift());
    return { content: pendingAnswers.shift() || '' };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: enabledToolNames || ['search_schema', 'execute_sql_query', 'resume_workflow', 'export_data'],
    context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } }, ...context } });
  return { result, seen };
}

test('grounded document answers are repaired once when a citation is missing', async t => {
  const evidence = [{ citationIndex: 1, payload: { title: 'Quy chế', fullText: 'Nghỉ phép 12 ngày.' } }];
  const { result } = await runForm(t, { question: 'Nghỉ phép bao nhiêu ngày?', enabledToolNames: [],
    answers: ['Nhân viên được nghỉ 12 ngày.', 'Nhân viên được nghỉ 12 ngày [1].'],
    context: { mode: 'knowledge', knowledgeGrounding: { required: true, documentContext: 'Tài liệu 1: Nghỉ phép 12 ngày.' }, citationEvidence: evidence, requestPlan: { outputs: { data: false } } } });
  assert.equal(result.replyText, 'Nhân viên được nghỉ 12 ngày [1].');
  assert.equal(result.trace.pipeline, 'v2');
  assert.equal(result.citationEvidence.length, 1);
});

test('conversation is answered in v2 instead of falling back to the agent loop', async t => {
  const { result } = await runForm(t, { question: 'Cảm ơn bạn nhé', contracts: [{ kind: 'chat' }], answers: ['Rất vui được hỗ trợ bạn!'] });
  assert.equal(result.replyText, 'Rất vui được hỗ trợ bạn!');
  assert.equal(result.trace.pipeline, 'v2');
  assert.ok(!result.trace.steps.some(step => step.type === 'V2_FALLBACK'));
});

test('a waiting workflow resumes with question-grounded inputs only', async t => {
  const pendingInput = { runId: 'run-9', revision: 3, name: 'Báo cáo', inputs: {
    months: { label: 'Số tháng', ask: 'Bao nhiêu tháng?', schema: { type: 'integer', minimum: 1, maximum: 24 } },
    exportFile: { label: 'Xuất file', ask: 'Có xuất file không?', schema: { type: 'boolean' } } } };
  const { result, seen } = await runForm(t, { question: '3 tháng, không cần', pendingInput,
    contracts: [{ kind: 'resume', workflow: { inputs: { months: 3, exportFile: false }, evidence: { months: '3 tháng', exportFile: 'không xuất' } } }] });
  // exportFile quoted "không xuất" is not in the message, so only months is sent.
  assert.deepEqual(seen.resumes, [{ runId: 'run-9', revision: 3, inputs: { months: 3 } }]);
  assert.ok(result.trace.steps.some(step => step.type === 'WORKFLOW_TOOL_HANDOFF'));
});

test('one file per group is exported from the verified rows of each group', async t => {
  const rows = [{ ID: 1, Phòng: 'CSKH' }, { ID: 2, Phòng: 'Kỹ thuật' }, { ID: 3, Phòng: 'CSKH' }];
  const { result, seen } = await runForm(t, { question: 'Xuất danh sách mỗi phòng một file excel', rows,
    context: { requestPlan: { outputs: { data: true, export: true } } },
    contracts: [{ kind: 'data', root: 'TestRows', operation: 'list', output: { export: 'xlsx', splitBy: 'TestRows.Dept' } }] });
  assert.deepEqual(seen.exports.map(item => [item.filename, item.data.length]), [['Bao_cao_CSKH', 2], ['Bao_cao_Ky_thuat', 1]]);
  assert.match(result.replyText, /\[CSKH\]\(\/api\/exports\/Bao_cao_CSKH\.xlsx\) — 2 bản ghi/);
});
