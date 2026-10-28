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
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent/tools/base_tool');
  const Manager = require('../src/backend/agent/tools/tool_manager');
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

async function runForm(t, { contracts = [], answers = [], context = {}, enabledToolNames, question, rows = [], pendingInput = null, tools = {} }) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [{ ...table,
    columns: [...table.columns, { columnName: 'Dept', dataType: 'NVARCHAR', displayName: 'Phòng' }] }]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  t.mock.method(require('../src/backend/governance/workflow_tools'), 'pendingInput', async () => pendingInput);
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent/tools/base_tool');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const manager = new Manager(), seen = { resumes: [], exports: [], prompts: [] };
  const register = (name, run) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = run; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['TestRows'], tableDirectory: [{ tableName: 'TestRows' }], intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => ({ sql: args.sql, rows }));
  register('resume_workflow', async args => { seen.resumes.push(args); return { runId: args.runId, execution: { id: args.runId, status: 'SUCCEEDED', name: 'Báo cáo' } }; });
  register('export_data', async args => { seen.exports.push(args); return { downloadUrl: `/api/exports/${args.filename}.xlsx` }; });
  for (const [name, run] of Object.entries(tools)) register(name, run);
  const pendingContracts = [...contracts], pendingAnswers = [...answers];
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, messages, definitions) => {
    seen.prompts.push({ tool: definitions[0]?.function?.name || null, messages });
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

test('a greeting skips schema search, document search and plan_query', async t => {
  const { result, seen } = await runForm(t, { question: 'Chào bạn!', answers: ['Xin chào! Mình có thể giúp gì?'],
    tools: { search_schema: async () => { throw new Error('search_schema must not run for a greeting'); } } });
  assert.equal(result.replyText, 'Xin chào! Mình có thể giúp gì?');
  assert.equal(result.trace.pipeline, 'v2');
  assert.equal(seen.prompts.length, 1);
  assert.ok(!seen.prompts.some(prompt => prompt.tool === 'plan_query'));
  assert.equal(result.trace.steps.find(step => step.type === 'ROUTING_DECISION')?.gate, 'social');
});

test('a greeting while a workflow waits for inputs still goes through plan_query', async t => {
  const pendingInput = { runId: 'run-1', revision: 1, name: 'Báo cáo', inputs: { months: { label: 'Số tháng', schema: { type: 'integer' } } } };
  const { seen } = await runForm(t, { question: 'hi', pendingInput, contracts: [{ kind: 'chat' }], answers: ['Xin chào!'] });
  assert.ok(seen.prompts.some(prompt => prompt.tool === 'plan_query'));
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

test('a list "theo X" without a file selects X and shows the records group by group', async t => {
  const rows = [{ ID: 1, Phòng: 'CSKH' }, { ID: 2, Phòng: 'Kỹ thuật' }, { ID: 3, Phòng: 'CSKH' }];
  const { result, seen } = await runForm(t, { question: 'Danh sách theo phòng', rows,
    contracts: [{ kind: 'data', root: 'TestRows', operation: 'list', fields: ['TestRows.ID'], groupBy: [{ ref: 'TestRows.Dept' }] }] });
  const sql = result.toolCalls.find(item => item.toolName === 'execute_sql_query')?.args.sql;
  assert.match(sql, /\[Dept\]/, 'the group column is selected even when fields omit it');
  assert.equal(seen.exports.length, 0);
  assert.match(result.replyText, /Chia theo \*\*Phòng\*\* thành \*\*2\*\* nhóm\./);
  assert.match(result.replyText, /\*\*CSKH \(2\)\*\*\n\n\|[^\n]+\n\| --- [^\n]+\n\| 1 \| CSKH \|\n\| 3 \| CSKH \|/);
  assert.match(result.replyText, /\*\*Kỹ thuật \(1\)\*\*/);
});

test('one file per group is exported from the verified rows of each group', async t => {
  const rows = [{ ID: 1, Phòng: 'CSKH' }, { ID: 2, Phòng: 'Kỹ thuật' }, { ID: 3, Phòng: 'CSKH' }];
  const { result, seen } = await runForm(t, { question: 'Xuất danh sách mỗi phòng một file excel', rows,
    context: { requestPlan: { outputs: { data: true, export: true } } },
    contracts: [{ kind: 'data', root: 'TestRows', operation: 'list', output: { export: 'xlsx', splitBy: 'TestRows.Dept' } }] });
  assert.deepEqual(seen.exports.map(item => [item.filename, item.data.length]), [['Bao_cao_CSKH', 2], ['Bao_cao_Ky_thuat', 1]]);
  assert.match(result.replyText, /\[CSKH\]\(\/api\/exports\/Bao_cao_CSKH\.xlsx\) — 2 bản ghi/);
  // The listed rows are split the same way as the files.
  assert.match(result.replyText, /thành \*\*2\*\* nhóm\./);
  assert.match(result.replyText, /\*\*CSKH \(2\)\*\*\n\n\|[^\n]+\n\| --- [^\n]+\n\| 1 \| CSKH \|\n\| 3 \| CSKH \|/);
  assert.match(result.replyText, /\*\*Kỹ thuật \(1\)\*\*\n\n\|[^\n]+\n\| --- [^\n]+\n\| 2 \| Kỹ thuật \|/);
  assert.equal((result.replyText.match(/Đã tra cứu được/g) || []).length, 1, 'one introduction for all groups');
});

// Counts how many calls of the wrapped tools are in flight at once.
function concurrency(names, delayMs, results) {
  const state = { active: 0, peak: 0 };
  const tools = Object.fromEntries(names.map(name => [name, async args => {
    state.active++; state.peak = Math.max(state.peak, state.active);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    state.active--;
    return results[name](args);
  }]));
  return { state, tools };
}

test('the workflow listing is read while schema retrieval runs', async t => {
  const { state, tools } = concurrency(['search_schema', 'list_workflows'], 20, {
    search_schema: () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['TestRows'], tableDirectory: [{ tableName: 'TestRows' }], intentCatalog: [], tables: [] }),
    list_workflows: () => ({ workflows: [report] }) });
  const { seen } = await runForm(t, { question: 'Cảm ơn bạn nhé', tools: { ...tools, run_workflow: async () => ({}) }, contracts: [{ kind: 'chat' }], answers: ['Rất vui được hỗ trợ bạn!'],
    enabledToolNames: ['search_schema', 'execute_sql_query', 'list_workflows', 'run_workflow'] });
  assert.equal(state.peak, 2);
  assert.match(seen.prompts.find(item => item.tool === 'plan_query').messages.at(-1).content, /WORKFLOWS: /);
});

test('saved preferences reach the v2 contract and answer; the clock is kept apart from the stage rules', async t => {
  const preference = { id: 'preference:1', kind: 'preference', data: { scope: 'personal', title: 'Đơn vị tiền', content: 'Hiển thị số tiền theo triệu đồng.', revision: 1 } };
  const { result, seen } = await runForm(t, { question: 'Cảm ơn bạn nhé', contracts: [{ kind: 'chat' }], answers: ['Rất vui được hỗ trợ bạn!'],
    tools: { list_workflows: async () => ({ workflows: [report] }), run_workflow: async () => ({}) },
    enabledToolNames: ['search_schema', 'execute_sql_query', 'list_workflows', 'run_workflow'],
    context: { resolutionContext: { candidates: [preference], recent: [], turns: [] } } });
  assert.equal(result.trace.pipeline, 'v2');
  const contract = seen.prompts.find(item => item.tool === 'plan_query').messages;
  assert.match(contract.at(-1).content, /PREFERENCES .*Hiển thị số tiền theo triệu đồng/);
  // The stage rules stay an unchanged first block that providers can cache.
  assert.doesNotMatch(contract[0].content, /Authoritative backend request clock/);
  assert.deepEqual(contract.map(message => message.role), ['system', 'system', 'user']);
  assert.match(contract[1].content, /^Authoritative backend request clock/);
  const chat = seen.prompts.find(item => item.tool === null).messages;
  assert.ok(chat.some(message => message.role === 'system' && /PREFERENCES .*triệu đồng/.test(message.content)));
});

test('the request clock is a separate block for remote models and joins the single system message for local ones', async t => {
  const { seen } = await runForm(t, { question: 'Cảm ơn bạn nhé', contracts: [{ kind: 'chat' }], answers: ['Rất vui được hỗ trợ bạn!'],
    context: { lockProvider: true } });
  assert.deepEqual(seen.prompts[0].messages.map(message => message.role), ['system', 'system', 'user']);
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const prompts = [];
  const harness = new Harness({ toolManager: { getToolDefinitions: () => [], executeTool: async () => ({ success: false }) },
    dispatch: async (_provider, messages) => { prompts.push(messages); return { content: 'Chào bạn.' }; } });
  await harness.run({ userMessage: 'chào', provider: { id: 'local', executionClass: 'local' }, enabledToolNames: [],
    context: { lockProvider: true, mode: 'general', requestPlan: { outputs: { data: false } } } });
  for (const messages of prompts) {
    assert.equal(messages[0].role, 'system');
    assert.equal(messages.slice(1).some(message => message.role === 'system'), false);
  }
});

test('group files are written together and names that fold alike stay distinct', async t => {
  const rows = [{ ID: 1, Phòng: 'Phòng A' }, { ID: 2, Phòng: 'Phong A' }, { ID: 3, Phòng: 'Phòng A' }];
  const exported = [];
  const { state, tools } = concurrency(['export_data'], 20, { export_data: args => {
    exported.push(args); return { downloadUrl: `/api/exports/${args.filename}.xlsx` }; } });
  const { result } = await runForm(t, { question: 'Xuất danh sách mỗi phòng một file excel', rows, tools,
    context: { requestPlan: { outputs: { data: true, export: true } } },
    contracts: [{ kind: 'data', root: 'TestRows', operation: 'list', output: { export: 'xlsx', splitBy: 'TestRows.Dept' } }] });
  assert.equal(state.peak, 2);
  assert.deepEqual(exported.map(item => [item.filename, item.data.length]).sort(), [['Bao_cao_Phong_A', 2], ['Bao_cao_Phong_A_2', 1]]);
  assert.ok(result.replyText.indexOf('[Phòng A]') < result.replyText.indexOf('[Phong A]'), 'links keep the group order');
});

test('a resume with nothing waiting points the repair at the finished workflow result', async t => {
  const finished = { question: 'Báo cáo sản lượng 3 tháng', status: 'SUCCESS', dbSourceId: 's',
    workflow: { runId: 'run-1', name: 'Báo cáo', field: 'rows', templateId: 'test/report' }, result: { rowCount: 2, columns: ['Tháng', 'Sản lượng'], preview: [['2025-01', 1], ['2025-02', 2]] } };
  const { seen } = await runForm(t, { question: 'Vẽ biểu đồ cột cho kết quả trên', answers: ['Đây là kết quả.'],
    contracts: [{ kind: 'resume', workflow: { inputs: { drawChart: true } } }, { kind: 'chat' }],
    context: { resolutionContext: { candidates: [], recent: [], turns: [finished] } } });
  const repair = seen.prompts.filter(item => item.tool === 'plan_query').at(-1).messages.at(-1).content;
  // Rejected for the missing run, not for missing quotes, and told where the result is.
  assert.match(repair, /V2_RESUME_UNAVAILABLE/);
  assert.doesNotMatch(repair, /V2_WORKFLOW_EVIDENCE_MISSING/);
  assert.match(repair, /kind=previous with previous\.turn=1/);
});

test('a rejected contract gets a repair hint with the refs that exist', async t => {
  const { result, seen } = await runForm(t, { question: 'tổng sản lượng', rows: [{ 'Tổng Sản lượng': 22 }], contracts: [
    { kind: 'data', root: 'TestRows', operation: 'aggregate', measures: [{ ref: 'TestRows.Quantity', aggregation: 'SUM' }] },
    { kind: 'data', root: 'TestRows', operation: 'aggregate', measures: [{ ref: 'TestRows.Qty', aggregation: 'SUM' }] }] });
  const repair = seen.prompts.filter(prompt => prompt.tool === 'plan_query')[1].messages.at(-1).content;
  assert.match(repair, /^The contract was rejected: V2_COLUMN_UNKNOWN: TestRows\.Quantity\. Use refs that exist, e\.g\. (?:TestRows\.\w+, )*TestRows\.Qty,/);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_CONTRACT_REJECTED' && step.hinted));
  assert.equal(result.trace.pipeline, 'v2');
});
