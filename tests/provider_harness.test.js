'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AgentHarness = require('../src/backend/agent_core/harness/agent_harness');
const BaseTool = require('../src/backend/agent_core/tools/base_tool');
const ToolManager = require('../src/backend/agent_core/tools/tool_manager');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
const { MemoryService } = require('../src/backend/memory_core/memory_service');
const fixture = require('./fixtures/provider_raw_contract_chat.json');
const provider = { id: 'guard-test', name: 'Test', executionClass: 'remote', supportsToolCalling: true };
const call = (name, args, id = 'test-call') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const sql = 'SELECT TOP 20 ContractID, ContractNo FROM T_Contract';

class FixtureTool extends BaseTool {
  constructor(name, run, parameters = { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }) {
    super({ name, description: name, parameters }); this.run = run;
  }
}
function setup(responses, { rows = fixture.rows, maxIterations = 6, maxRepairs = 2, ...overrides } = {}) {
  const executed = [];
  const requests = [];
  const manager = new ToolManager();
  manager.registerTool(new FixtureTool('execute_sql_query', async args => { executed.push(args); return { sql: args.sql, rows, rowCount: rows.length }; }));
  const harness = new AgentHarness({ toolManager: manager, maxIterations, maxRepairs, dispatch: async (p, messages, tools, signal) => {
    requests.push({ provider: p, messages: structuredClone(messages), tools, signal });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response || fixture.response;
  }, ...overrides });
  const run = extra => harness.run({ userMessage: fixture.question, provider, messages: [{ role: 'user', content: fixture.question }],
    enabledToolNames: ['execute_sql_query'], context: { requestPlan: fixture.plan, mode: 'data' }, ...extra });
  return { harness, run, executed, requests, manager };
}

test('recorded SQL-only contract response is repaired before it can reach the user', async () => {
  const s = setup([fixture.response, { tool_calls: [call('execute_sql_query', { sql })] }, { content: 'Đây là danh sách hợp đồng.' }]);
  const result = await s.run();
  assert.equal(s.executed.length, 1);
  assert.match(result.replyText, /HD-TEST-001/);
  assert.doesNotMatch(result.replyText, /```sql|SELECT TOP/);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(result.trace.executionBudget.repairAttempts, 1);
  assert.ok(s.requests[1].messages.some(m => m.content?.includes('MISSING_SQL')));
});

test('persistent SQL-only answers stop within repair budget and never enter successful memory', async () => {
  const s = setup(Array(6).fill(fixture.response));
  const result = await s.run();
  assert.equal(s.requests.length, 3);
  assert.equal(s.executed.length, 0);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.doesNotMatch(result.replyText, /SELECT|```/);
  const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
  const saved = memory.persistSuccessfulExchange({ sessionId: 'test', question: fixture.question, reply: result.replyText,
    currentPlan: fixture.plan, completionStatus: result.trace.completionStatus, responseEvaluation: result.trace.training.responseEvaluation });
  assert.equal(saved.persisted, false);
});

test('third-party provider uses deterministic enrichment recovery for a limited list', async () => {
  const plan = { intent: 'list', table: 'M_Employee', rowLimit: 5, schemaColumns: ['EmployeeID', 'EmployeeName', 'GenderID'],
    requiredColumns: [], outputs: { data: true, chart: false, export: false } };
  const joinPlan = { outcome: 'ready', purpose: 'enrichment', tableRefs: [
    { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
    { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' }
  ], edges: [{ relationshipId: 'gender', fromTableId: 'employee', toTableId: 'constant', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
    joinType: 'LEFT', businessRole: 'Giới tính', displayColumn: 'ConstantName', columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }] };
  const s = setup([{ content: 'Không có dữ liệu.' }], { maxRepairs: 0, rows: [{ EmployeeID: 1, EmployeeName: 'Duy', ConstantName: 'Nam' }] });
  const result = await s.run({ userMessage: 'ds 5 nv', messages: [{ role: 'user', content: 'ds 5 nv' }],
    context: { requestPlan: plan, joinPlan, selectedTables: ['M_Employee', 'M_Constant'], mode: 'data' } });
  assert.equal(s.executed.length, 1);
  assert.match(s.executed[0].sql, /^SELECT TOP 5 t1\.\[EmployeeName\], t2\.\[ConstantName\] AS \[Giới tính\], t1\.\[EmployeeID\]/);
  assert.ok(result.trace.steps.some(step => step.type === 'ENRICHED_LIST_RECOVERY' && step.success));
  assert.match(result.replyText, /Duy/);
});

test('third-party provider recovers plural follow-ups from verified dataset keys', async () => {
  const plan = { intent: 'record_lookup', table: 'M_Employee', question: '2 nhân viên này thuộc phòng ban gì',
    schemaColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName', 'DepartmentID'], requiredColumns: [],
    outputs: { data: true, chart: false, export: false } };
  const joinPlan = { outcome: 'ready', purpose: 'enrichment', tableRefs: [
    { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
    { tableRefId: 'master#2', tableId: 'master', tableName: 'M_Master', schemaName: 'dbo', alias: 't2' }
  ], edges: [{ relationshipId: 'department', fromTableId: 'employee', toTableId: 'master',
    fromTableRefId: 'employee#1', toTableRefId: 'master#2', joinType: 'LEFT', businessRole: 'Phòng ban',
    displayColumn: 'Name', columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'MasterID' }] }] };
  const reference = { type: 'lastDataset', data: { table: 'M_Employee', entityKeys: [
    { EmployeeID: 5 }, { EmployeeID: 6 }
  ] } };
  const s = setup([{ content: 'Chưa có dữ liệu.' }], { maxRepairs: 0,
    rows: [{ EmployeeCode: 'NV005', EmployeeName: 'Demo3', 'Phòng ban': 'CSKH' },
      { EmployeeCode: 'NV006', EmployeeName: 'Nguyễn Văn A', 'Phòng ban': 'Kỹ thuật' }] });
  const result = await s.run({ userMessage: plan.question, messages: [{ role: 'user', content: plan.question }],
    context: { requestPlan: plan, joinPlan, memoryDecision: { mode: 'reference', reference },
      selectedTables: ['M_Employee', 'M_Master'], mode: 'data' } });
  assert.equal(s.executed.length, 1);
  assert.match(s.executed[0].sql, /t1\.\[EmployeeID\] = 5/);
  assert.match(s.executed[0].sql, /t1\.\[EmployeeID\] = 6/);
  assert.match(s.executed[0].sql, /t2\.\[Name\] AS \[Phòng ban\]/);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('explicit SQL authoring is answered as code without execution', async () => {
  const s = setup([fixture.response]);
  const result = await s.run({ userMessage: 'Viết SQL lấy danh sách hợp đồng' });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.match(result.replyText, /SELECT TOP/);
  assert.equal(s.executed.length, 0);
  assert.equal(s.requests[0].tools.length, 0);
});

test('wrong tables, unknown columns and unrequested filters are rejected before execution', async () => {
  for (const [badSql, category] of [['SELECT ContractID FROM WrongTable', 'WRONG_TABLE'],
    ['SELECT InventedColumn FROM T_Contract', 'UNKNOWN_COLUMN:InventedColumn'],
    ['SELECT ContractID FROM T_Contract WHERE ContractID = 1', 'UNREQUESTED_FILTER']]) {
    const s = setup([{ tool_calls: [call('execute_sql_query', { sql: badSql })] }, { tool_calls: [call('execute_sql_query', { sql })] }, { content: 'Danh sách hợp đồng.' }]);
    const result = await s.run();
    assert.equal(s.executed.length, 1);
    assert.equal(s.executed[0].sql, sql);
    assert.ok(result.trace.steps.some(step => step.type === category));
  }
});

test('zero rows is a valid completed result and does not loosen filters', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql })] }, { content: 'Không tìm thấy dữ liệu phù hợp.' }], { rows: [] });
  const result = await s.run();
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(s.executed.length, 1);
  assert.match(result.replyText, /Không tìm thấy/);
});

test('identical tool calls execute only once even when model repeats them', async () => {
  const s = setup(Array(6).fill({ tool_calls: [call('execute_sql_query', { sql })] }));
  const result = await s.run();
  assert.equal(s.executed.length, 1);
  assert.ok(result.trace.steps.some(step => step.type === 'NO_PROGRESS'));
  assert.match(result.replyText, /HD-TEST-001/);
});

test('disabled tools are rejected both by the harness and direct ToolManager dispatch', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql })] }], { maxRepairs: 0 });
  const result = await s.run({ enabledToolNames: [] });
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  const direct = await s.manager.executeTool('execute_sql_query', { sql }, { allowedToolNames: [] });
  assert.equal(direct.success, false);
  assert.equal(s.executed.length, 0);
});

test('content JSON requires an explicit compatibility capability', async () => {
  const json = { content: JSON.stringify({ tool: 'execute_sql_query', arguments: { sql } }) };
  const disabled = setup([json], { maxRepairs: 0 });
  assert.equal((await disabled.run()).trace.completionStatus, 'PARTIAL');
  assert.equal(disabled.executed.length, 0);
  const enabled = setup([json, { content: 'Danh sách hợp đồng.' }]);
  const result = await enabled.run({ provider: { ...provider, supportsToolCalling: false, supportsJsonToolCalling: true } });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(enabled.executed.length, 1);
  assert.ok(enabled.requests[0].messages[0].content.includes('Available tools'));
  assert.equal(enabled.requests[1].messages.some(message => message.role === 'tool'), false);
});

test('web and selected knowledge requests are not forced to execute SQL', async () => {
  for (const context of [{ webSearch: true, webSearchResultCount: 1 }, { mode: 'knowledge', knowledgeGrounding: { required: true } }]) {
    const s = setup([{ content: 'Theo tài liệu được cung cấp, hợp đồng có thời hạn 12 tháng [1].' }]);
    const result = await s.run({ context: { requestPlan: fixture.plan, ...context }, enabledToolNames: [] });
    assert.equal(result.trace.completionStatus, 'SUCCESS');
    assert.equal(s.executed.length, 0);
  }
});

test('third-party provider repairs a knowledge answer that omits citation markers', async () => {
  const s = setup([
    { content: 'Hợp đồng có thời hạn 12 tháng.' },
    { content: 'Hợp đồng có thời hạn 12 tháng [1].' }
  ]);
  const result = await s.run({
    context: {
      requestPlan: fixture.plan,
      mode: 'knowledge',
      knowledgeGrounding: {
        required: true,
        documentContext: '[Tài liệu 1: Quy định hợp đồng · đoạn 2]\nHợp đồng có thời hạn 12 tháng.'
      }
    },
    enabledToolNames: []
  });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.match(result.replyText, /\[1\]/);
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[1].messages.at(-1).content, /MISSING_KNOWLEDGE_CITATION/);
});

test('missing chart and export cannot be claimed complete', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql })] }, { content: 'Đã tạo biểu đồ và xuất file.' }], { maxRepairs: 0 });
  const result = await s.run({ context: { requestPlan: { ...fixture.plan, outputs: { data: true, chart: true, export: true } } } });
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.ok(result.trace.training.responseEvaluation.failures.includes('MISSING_CHART'));
  assert.ok(result.trace.training.responseEvaluation.failures.includes('MISSING_EXPORT'));
  assert.doesNotMatch(result.replyText, /Đã tạo biểu đồ và xuất file/);
});

test('caller cancellation prevents further dispatch or tool execution', async () => {
  const controller = new AbortController();
  const s = setup([], { dispatch: async () => { controller.abort(); return { tool_calls: [call('execute_sql_query', { sql })] }; } });
  await assert.rejects(() => s.run({ context: { requestPlan: fixture.plan, signal: controller.signal } }), { name: 'AbortError' });
  assert.equal(s.executed.length, 0);
});

test('shared SQL budget prevents additional SQL attempts', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql }), call('execute_sql_query', { sql: sql.replace('20', '10') }, 'second')] }]);
  const executionBudget = new RequestExecutionBudget({ executionClass: 'remote', maxSqlAttempts: 1 });
  const result = await s.run({ context: { requestPlan: fixture.plan, executionBudget } });
  assert.equal(s.executed.length, 1);
  assert.equal(result.trace.executionBudget.sqlAttempts, 1);
  assert.ok(result.trace.steps.some(step => step.type === 'SQL_BUDGET_EXCEEDED'));
});

test('total deadline bounds a provider that ignores cancellation', async () => {
  const s = setup([], { dispatch: async () => new Promise(() => {}) });
  const executionBudget = new RequestExecutionBudget({ executionClass: 'remote', timeoutMs: 25 });
  const started = Date.now();
  const result = await s.run({ context: { requestPlan: fixture.plan, executionBudget } });
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(s.executed.length, 0);
});

test('fallback retains the request budget and retries only recoverable provider errors', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const fallback = { ...provider, id: 'fallback', baseUrl: 'https://test.invalid', model: 'test' };
  t.mock.method(providers, 'getProvidersForExecution', () => [fallback]);
  const attempted = [];
  const s = setup([], { dispatch: async p => {
    attempted.push(p.id);
    if (p.id === provider.id) throw Object.assign(new Error('rate limited'), { status: 429 });
    return { content: 'Xin chào.' };
  } });
  const result = await s.run({ userMessage: 'Xin chào', context: { mode: 'general' }, enabledToolNames: [] });
  assert.deepEqual(attempted, [provider.id, fallback.id]);
  assert.equal(result.trace.executionBudget.modelCalls, 2);
  assert.equal(result.providerFallbacks.length, 1);
  assert.equal(result.usedProvider.id, fallback.id);
  const denied = [];
  const auth = setup([], { dispatch: async p => { denied.push(p.id); throw Object.assign(new Error('auth failed'), { status: 401 }); } });
  assert.equal((await auth.run()).trace.completionStatus, 'PARTIAL');
  assert.deepEqual(denied, [provider.id]);
});

test('multi-tool response produces matching results and an export bound to complete SQL rows', async () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ ContractID: index + 1, ContractNo: `HD-${index + 1}` }));
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql }), call('export_data', { data: rows.slice(0, 2), format: 'csv' }, 'export')] },
    { content: 'Đã xuất danh sách hợp đồng.' }], { rows });
  let exported;
  s.manager.registerTool(new FixtureTool('export_data', async args => { exported = args.data; return { downloadUrl: '/api/exports/test.csv' }; },
    { type: 'object', properties: { data: { type: 'array' }, format: { type: 'string' } }, required: ['data', 'format'] }));
  const result = await s.run({ enabledToolNames: ['execute_sql_query', 'export_data'],
    context: { requestPlan: { ...fixture.plan, outputs: { data: true, export: true } } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(exported.length, 25);
  assert.equal(s.requests[1].messages.filter(message => message.role === 'tool').length, 2);
  assert.match(result.replyText, /\/api\/exports\/test.csv/);
});

test('chart values invented after a successful SQL query are rejected', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql }), call('render_chart', { type: 'bar', labels: ['HD-TEST-001'], datasets: [{ data: [999] }] }, 'chart')] }], { maxRepairs: 0 });
  let rendered = false;
  s.manager.registerTool(new FixtureTool('render_chart', async args => { rendered = true; return { chartSpec: args }; },
    { type: 'object', properties: { type: { type: 'string' }, labels: { type: 'array' }, datasets: { type: 'array' } }, required: ['type', 'labels', 'datasets'] }));
  const result = await s.run({ enabledToolNames: ['execute_sql_query', 'render_chart'],
    context: { requestPlan: { ...fixture.plan, outputs: { data: true, chart: true } } } });
  assert.equal(rendered, false);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.ok(result.trace.steps.some(step => step.type === 'UNVERIFIED_OUTPUT_DATA'));
});

test('provider context limit is honored before dispatch', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  t.mock.method(providers, 'getProvidersForExecution', () => []);
  const s = setup([]);
  const result = await s.run({ provider: { ...provider, contextWindow: 32, outputReserve: 16 } });
  assert.equal(s.requests.length, 0);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(result.trace.stopReason, 'CONTEXT_BUDGET_EXCEEDED');
});

test('model without tool capability is reported clearly without dispatch', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  t.mock.method(providers, 'getProvidersForExecution', () => []);
  const s = setup([]);
  const result = await s.run({ provider: { ...provider, supportsToolCalling: false } });
  assert.equal(s.requests.length, 0);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(result.trace.stopReason, 'TOOL_CAPABILITY_UNAVAILABLE');
  assert.match(result.replyText, /chưa hỗ trợ công cụ/);
});

test('verified chart values are accepted and complete the request', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql }), call('render_chart', { type: 'bar', labels: ['HD-TEST-001'], datasets: [{ data: [1] }] }, 'chart')] },
    { content: 'Đã tạo biểu đồ từ dữ liệu hợp đồng.' }]);
  s.manager.registerTool(new FixtureTool('render_chart', async args => ({ chartSpec: args }),
    { type: 'object', properties: { type: { type: 'string' }, labels: { type: 'array' }, datasets: { type: 'array' } }, required: ['type', 'labels', 'datasets'] }));
  const result = await s.run({ enabledToolNames: ['execute_sql_query', 'render_chart'],
    context: { requestPlan: { ...fixture.plan, outputs: { data: true, chart: true } } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.ok(result.toolCalls.some(item => item.toolName === 'render_chart' && item.success));
});

test('native tools remain the requested behavior when user explicitly asks to write and execute SQL', async () => {
  const s = setup([{ tool_calls: [call('execute_sql_query', { sql })] }, { content: 'Danh sách hợp đồng.' }]);
  const result = await s.run({ userMessage: 'Viết SQL lấy danh sách hợp đồng và chạy truy vấn' });
  assert.equal(s.executed.length, 1);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('memory does not reuse a dataset after switching databases', () => {
  const { routeMemory } = require('../src/backend/memory_core/memory_router');
  const result = routeMemory({ question: 'vẽ biểu đồ dữ liệu đó', currentPlan: { table: 'T_Contract', dbSourceId: 'new-db' },
    session: { id: 'test', lastPlan: { table: 'T_Contract', dbSourceId: 'old-db' }, references: {} } });
  assert.equal(result.mode, 'none');
  assert.equal(result.reason, 'database_source_changed');
});

test('invalid context configuration never mutates provider or persists it', async t => {
  const providers = require('../src/backend/services/ai_provider_manager');
  const target = providers.getProvidersForExecution()[0];
  const previous = { ...target };
  let saved = false;
  t.mock.method(providers, 'persist', () => { saved = true; });
  assert.throws(() => providers.updateProvider(target.id, { name: 'must not save', contextWindow: 1024, outputReserve: 2048 }));
  assert.deepEqual(target, previous);
  assert.equal(saved, false);
});

test('legacy raw SQL and tool JSON turns do not re-enter memory through client history', () => {
  const { sanitizeMessages } = require('../src/backend/memory_core/memory_sanitizer');
  const messages = sanitizeMessages([
    { role: 'user', content: fixture.question }, { role: 'assistant', content: fixture.response.content },
    { role: 'user', content: 'query' }, { role: 'assistant', content: '{"tool":"execute_sql_query","arguments":{"sql":"SELECT 1"}}' },
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'Xin chào' }
  ]);
  assert.deepEqual(messages, [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Xin chào' }]);
});
