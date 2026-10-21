'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
test('chart/export requirement cannot be satisfied by a lookup workflow', async () => {
  const { assess } = require('../src/backend/memory_core/workflow_suitability');
  let calls = 0;
  const dispatch = async () => { calls++; return { content: '{"suitable":true,"reason":"lookup"}' }; };
  for (const resolution of [{ operation: 'chart' }, { operation: 'aggregate', outputs: { chart: true } }, { operation: 'export' }])
    await assert.rejects(assess(dispatch, 'test', resolution, { name: 'Lookup', tags: ['operation:detail'] }), { code: 'WORKFLOW_OPERATION_MISMATCH' });
  assert.equal(calls, 0);
});
test('chart intent is retained after a general-mode conversation resolution', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const harness = new Harness({ toolManager: { getToolDefinitions: () => [] }, maxRepairs: 0,
    dispatch: async (provider, messages, definitions) => definitions.some(item => item.function?.name === 'resolve_conversation')
      ? { content: JSON.stringify({ relation: 'independent', sourceScope: 'enterprise', operation: 'chart', cardinality: 'collection', attributes: [], selectedIds: [], clarification: '', dataUse: 'current', presentation: 'chart' }) }
      : { content: 'Có hai dòng dữ liệu.' } });
  const result = await harness.run({ userMessage: 'vẽ biểu đồ', provider: { id: 'test', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'general', requestPlan: { outputs: { data: false, chart: false } }, resolutionContext: { candidates: [], recent: [{ role: 'user', content: 'Xin chào' }] } } });
  assert.equal(result.trace.training.plan.outputs.chart, true);
  assert.ok(result.trace.training.responseEvaluation.failures.includes('MISSING_CHART'));
});
test('derived monthly aggregate remains qualified and year/month chart labels are grounded', () => {
  const { qualifiedSql, validateOutputData } = require('../src/backend/agent_core/harness/completion_policy');
  const sql = 'SELECT Y, M, Qty FROM (SELECT YEAR(D) AS Y, MONTH(D) AS M, SUM(Q) AS Qty FROM TestRows GROUP BY YEAR(D), MONTH(D)) AS grouped ORDER BY Y,M';
  const call = { toolName: 'execute_sql_query', success: true, args: { sql }, result: { rows: [{ Y: 2024, M: 1, Qty: 12 }] } };
  assert.equal(qualifiedSql([call], { table: 'TestRows', conversationState: { operation: 'aggregate' } }).length, 1);
  assert.equal(validateOutputData('render_chart', { labels: ['2024-01'], datasets: [{ data: [12] }] }, [call]), true);
  assert.equal(validateOutputData('render_chart', { labels: ['2024-02'], datasets: [{ data: [12] }] }, [call]), false);
});
test('latest monthly buckets select descending then present chronologically with explicit projection', () => {
  const { compile } = require('../src/backend/services/semantic_query');
  const result = compile({ table: 'TestRows', operation: 'aggregate', time: { column: 'D', grain: 'month', latestBuckets: 7 }, measures: [{ column: 'Q', aggregation: 'SUM' }] },
    [{ tableName: 'TestRows', isActive: true, columns: [{ columnName: 'D', dataType: 'date' }, { columnName: 'Q', dataType: 'int' }] }]);
  assert.ok(result.sql.includes('TOP 7'));
  assert.ok(result.sql.includes('[period] DESC'));
  assert.ok(result.sql.endsWith('[period] ASC'));
  assert.ok(!result.sql.includes('*'));
});
test('backend plan execution is evidence, never a forged native provider function frame', () => {
  const { wireMessages } = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const messages = [{ role: 'assistant', backendGenerated: true, tool_calls: [{ id: 'backend', function: { name: 'execute_sql_query', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'backend', name: 'execute_sql_query', content: '{"success":true}' },
    { role: 'assistant', tool_calls: [{ id: 'native' }], rawParts: [{ thoughtSignature: 'signed' }] },
    { role: 'tool', tool_call_id: 'native', name: 'list_workflows', content: '{}' }];
  const outgoing = wireMessages(messages, { supportsToolCalling: true });
  assert.equal(outgoing[0].role, 'user');
  assert.ok(outgoing[0].content.includes('backendExecutionEvidence'));
  assert.deepEqual(outgoing.slice(1), messages.slice(2));
});
test('monthly renderer binds exact SQL aggregates and chronological labels without model numbers', () => {
  const { bindMonthly } = require('../src/backend/agent_core/harness/chart_evidence');
  const source = { args: { sql: 'SELECT DATEFROMPARTS(YEAR(D),MONTH(D),1) AS period, SUM(Q) AS Qty FROM TestRows GROUP BY DATEFROMPARTS(YEAR(D),MONTH(D),1)' },
    result: { rows: [{ period: new Date('2024-02-01'), Qty: 0 }, { period: new Date('2024-01-01'), Qty: 12 }] } };
  const bound = bindMonthly({ type: 'line', labels: ['wrong'], datasets: [{ label: 'Qty', data: [999] }] }, source);
  assert.deepEqual(bound.labels, ['2024-01', '2024-02']);
  assert.deepEqual(bound.datasets[0].data, [12, 0]);
  source.result.rows[0].Qty = null;
  assert.equal(bindMonthly({ type: 'line' }, source), null);
});
test('chart output stage runs after agent round limit and discloses short coverage', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const ToolManager = require('../src/backend/agent_core/tools/tool_manager'), BaseTool = require('../src/backend/agent_core/tools/base_tool');
  const manager = new ToolManager();
  const sql = 'SELECT YEAR(D) AS Y, MONTH(D) AS M, SUM(Q) AS Qty FROM TestRows GROUP BY YEAR(D), MONTH(D)';
  const rows = [{ Y: 2024, M: 1, Qty: 12 }, { Y: 2024, M: 2, Qty: 15 }];
  class Data extends BaseTool { constructor() { super({ name: 'execute_sql_query', description: 'Isolated test query', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }); } async run() { return { rows, sql }; } }
  class Chart extends BaseTool { constructor() { super({ name: 'render_chart', description: 'Isolated test chart', parameters: { type: 'object', properties: { labels: { type: 'array' }, datasets: { type: 'array' } }, required: ['labels', 'datasets'] } }); } async run(args) { return { chartSpec: { type: 'line', data: args } }; } }
  manager.registerTools([new Data(), new Chart()]);
  const invoke = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const harness = new Harness({ toolManager: manager, maxIterations: 1,
    dispatch: async (provider, messages, definitions) => definitions.length === 1 && definitions[0].function.name === 'render_chart'
      ? invoke('render_chart', { labels: ['2024-01', '2024-02'], datasets: [{ label: 'Qty', data: [12, 15] }] }) : invoke('execute_sql_query', { sql }) });
  const result = await harness.run({ userMessage: 'vẽ biểu đồ 7 tháng', provider: { id: 'test', supportsToolCalling: true },
    context: { lockProvider: true, mode: 'data', requestPlan: { table: 'TestRows', temporalMonths: 7, timeColumn: 'D', outputs: { data: true, chart: true }, conversationState: { operation: 'aggregate' } } } });
  assert.ok(result.toolCalls.some(call => call.toolName === 'render_chart' && call.success));
  assert.ok(result.replyText.includes('chưa đủ 7 tháng'));
  assert.deepEqual(result.toolCalls.find(call => call.toolName === 'render_chart').result.chartSpec.data.datasets[0].data, [12, 15]);
});

