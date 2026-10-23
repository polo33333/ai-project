'use strict';
// Đợt 2/3 stability: routed repairs, JOIN plan lifecycle, workflow handoff
// text and code-computed anomaly analysis.
const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/backend/agent_core/harness/repair_router');
const { reconcile } = require('../src/backend/agent_core/harness/join_plan_lifecycle');
const workflowReply = require('../src/backend/agent_core/harness/workflow_reply');
const analysis = require('../src/backend/agent_core/harness/analysis_response');

test('repair router repairs the earliest failed phase and keeps stage guidance free', () => {
  assert.equal(router.route(['TOOL_NOT_IN_STAGE']).free, true);
  assert.equal(router.route(['WORKFLOW_OPERATION_MISMATCH']).phase, 'stage');
  const mixed = router.route(['TOOL_NOT_IN_STAGE', 'JOIN_GRAIN_UNSAFE', 'MISSING_CHART']);
  assert.equal(mixed.phase, 'join');
  assert.equal(mixed.free, false);
  assert.match(mixed.instruction, /aggregate each fact table separately/);
  assert.equal(router.route(['REQUEST_FILTER_REQUIRED']).phase, 'scope');
  assert.equal(router.route(['CONTRACT_FIELDS_NOT_QUERIED']).phase, 'fields');
  assert.equal(router.route(['SQL_AGGREGATION_REQUIRED']).phase, 'measure');
  assert.equal(router.route(['ANALYSIS_CRITERION_MISSING']).phase, 'analysis');
  assert.match(router.route(['CONTRACT_ATTRIBUTES_UNRESOLVED']).instruction, /Reconcile the unresolved request attributes/);
  assert.equal(router.signature(['B', 'A', 'A']), router.signature(['A', 'B']));
});

const ref = (tableId, tableName) => ({ tableRefId: `${tableId}#1`, tableId, tableName, schemaName: 'dbo' });
const ready = (root, tables) => ({ outcome: 'ready', dbSourceId: 's', rootTableId: root, tableRefs: tables.map(id => ref(id, id)), edges: [] });

test('a narrower schema refresh keeps the broader verified JOIN plan', () => {
  const broad = ready('detail', ['detail', 'header', 'customer']);
  const narrow = ready('detail', ['detail', 'customer']);
  assert.deepEqual(reconcile(broad, narrow, { dbSourceId: 's' }), { plan: broad, action: 'retained' });
  assert.equal(reconcile(broad, null, { dbSourceId: 's' }).action, 'retained');
  assert.equal(reconcile(narrow, broad, { dbSourceId: 's' }).plan, broad);
});

test('different table sets are re-planned together; a new root or source replaces the plan', () => {
  const a = ready('detail', ['detail', 'header']), b = ready('detail', ['detail', 'period']);
  let requested;
  const merged = reconcile(a, b, { dbSourceId: 's', planJoin: (ids, options) => { requested = { ids, options }; return ready('detail', ids); } });
  assert.equal(merged.action, 'merged');
  assert.deepEqual(requested.ids.sort(), ['detail', 'header', 'period']);
  assert.equal(requested.options.rootTableId, 'detail');
  assert.equal(reconcile(a, b, { dbSourceId: 's', planJoin: () => ({ outcome: 'ambiguous', code: 'JOIN_ROLE_AMBIGUOUS' }) }).action, 'conflict');
  assert.equal(reconcile(a, ready('invoice', ['invoice']), { dbSourceId: 's' }).action, 'root_changed');
  assert.equal(reconcile(a, null, { dbSourceId: 's', nextRootTableId: 'invoice' }).action, 'root_changed');
  assert.equal(reconcile({ ...a, dbSourceId: 'other' }, b, { dbSourceId: 's' }).action, 'replaced');
});

test('workflow handoff names the workflow and lists exactly the missing inputs', () => {
  const waiting = workflowReply.reply({ status: 'WAITING_INPUT', name: 'Báo cáo sản lượng', missingInputs: [{ key: 'months', ask: 'Bao nhiêu tháng?' }, { key: 'exportFile' }], inputLabels: { exportFile: 'Xuất file Excel' } });
  assert.match(waiting, /\*\*Báo cáo sản lượng\*\*/);
  assert.match(waiting, /- Bao nhiêu tháng\?\n- Xuất file Excel/);
  assert.match(workflowReply.reply({ status: 'SUCCEEDED', name: 'X' }), /Đã chạy xong quy trình \*\*X\*\*/);
  assert.equal(workflowReply.reply({ status: 'WAITING_INPUT' }), 'Cần bổ sung thông tin để tiếp tục quy trình.');
  assert.match(workflowReply.reply({ status: 'FAILED', error: { message: 'timeout' } }), /Lý do: timeout/);
});

const months = values => ({ toolName: 'execute_sql_query', success: true,
  args: { sql: 'SELECT YEAR(DocDate) AS Nam, MONTH(DocDate) AS Thang, SUM(Qty) AS TongSanLuong FROM Usage GROUP BY YEAR(DocDate), MONTH(DocDate)' },
  result: { sql: 'SELECT YEAR(DocDate) AS Nam, MONTH(DocDate) AS Thang, SUM(Qty) AS TongSanLuong FROM Usage GROUP BY YEAR(DocDate), MONTH(DocDate)',
    rows: values.map(([month, value]) => ({ Nam: 2025, Thang: month, TongSanLuong: value })) } });

test('anomaly verdict is computed by a named method with baseline, threshold and coverage', () => {
  const series = months([[1, 100], [2, 104], [3, 98], [4, 101], [5, 99], [6, 102], [7, 300], [8, 97]]);
  const computed = analysis.seriesAnomalyReply(series, { analysisTask: 'anomaly' }, 'tháng nào tiêu thụ bất thường');
  assert.equal(computed.result.verdict, 'ANOMALIES_FOUND');
  assert.deepEqual(computed.result.flagged.map(item => [item.period, item.direction]), [['2025-07', 'high']]);
  assert.equal(computed.result.methodId, 'robust_modified_z');
  assert.match(computed.text, /\*\*Tiêu chí:\*\*.*trung vị/);
  assert.match(computed.text, /không phải ngưỡng nghiệp vụ/);
  // The rendered answer passes the completion gate on its own content.
  const { evaluateCompletion } = require('../src/backend/agent_core/harness/completion_policy');
  assert.ok(!evaluateCompletion({ reply: computed.text, plan: { table: 'Usage', outputs: { data: true }, analysisTask: 'anomaly' }, toolCalls: [series] })
    .failures.includes('ANALYSIS_CRITERION_MISSING'));
});

test('stable, short, gapped or user-criterion series never produce an invented verdict', () => {
  const stable = analysis.seriesAnomalyReply(months([[1, 100], [2, 101], [3, 99], [4, 100], [5, 102], [6, 98]]), { analysisTask: 'anomaly' });
  assert.equal(stable.result.verdict, 'NO_ANOMALY');
  const short = analysis.seriesAnomalyReply(months([[1, 100], [2, 400], [3, 100]]), { analysisTask: 'anomaly' });
  assert.equal(short.result.verdict, 'INSUFFICIENT_DATA');
  assert.equal(short.result.flagged.length, 0);
  assert.match(short.text, /Chưa đủ căn cứ/);
  const gapped = analysis.seriesAnomalyReply(months([[1, 100], [2, 101], [5, 99], [6, 100], [7, 102], [8, 98]]), { analysisTask: 'anomaly' });
  assert.deepEqual(gapped.result.coverage.missingMonths, ['2025-03', '2025-04']);
  assert.match(gapped.text, /không được tính là 0/);
  assert.equal(analysis.seriesAnomalyReply(months([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]]), { analysisTask: 'anomaly' }, 'tháng nào tăng quá 20%'), null);
  assert.equal(analysis.seriesAnomalyReply(months([[1, 1], [2, 2], [3, 3]]), { analysisTask: 'trend' }), null);
  // Equal months make MAD zero; the fallback scale still flags a real outlier.
  assert.equal(analysis.assessSeries(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'], [10, 10, 10, 10, 10, 50]).verdict, 'ANOMALIES_FOUND');
});

test('a revise follow-up of an empty previous request is a valid follow-up, not an independent question', () => {
  const { decode } = require('../src/backend/memory_core/conversation_resolver');
  const value = { relation: 'followup', operation: 'list', cardinality: 'collection', attributes: [], selectedIds: [], clarification: '', dataUse: 'current', scopeAction: 'revise' };
  const response = { content: JSON.stringify(value) };
  assert.throws(() => decode(response, []), /MISSING_REFERENCE/);
  assert.equal(decode(response, [], { previousRequest: { businessState: { table: 'T_ElectricityOutput' } } }).relation, 'followup');
  const { dependsOnPrevious } = require('../src/backend/memory_core/followup_policy');
  assert.equal(dependsOnPrevious('vậy tìm trong năm 2024 đi'), true);
  assert.equal(dependsOnPrevious('còn khách DC6011 thì sao?'), true);
  assert.equal(dependsOnPrevious('con số doanh thu tháng 3'), false);
  const state = require('../src/backend/memory_core/business_state').fromPlan({ table: 'T', requestFilters: [{ table: 'M_Customer', column: 'CustomerCode', value: 'KA0021' }] });
  assert.deepEqual(state.requestFilters, [{ table: 'M_Customer', column: 'CustomerCode', value: 'KA0021' }]);
});

test('a revise follow-up keeps the previous customer filter and says so in the answer', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), executed = [];
  for (const name of ['list_workflows', 'search_schema', 'execute_sql_query']) {
    const tool = new Base({ name, description: name, parameters: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string' } } } });
    tool.run = async args => name === 'list_workflows' ? { workflows: [] } : name === 'search_schema'
      ? { mode: 'data', dbSourceId: 'fixture', selectedTables: ['T_ElectricityOutput'], tables: [{ tableName: 'T_ElectricityOutput', columns: [{ name: 'ElectricityOutputID' }] }] }
      : (executed.push(args.sql), { sql: args.sql, rows: [{ ElectricityOutputID: 7 }] });
    manager.registerTool(tool);
  }
  const call = (name, args) => ({ tool_calls: [{ id: `${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const unfiltered = "SELECT o.ElectricityOutputID FROM T_ElectricityOutput o WHERE o.ElectricityOutputDate >= '2024-01-01' AND o.ElectricityOutputDate < '2025-01-01'";
  const filtered = "SELECT o.ElectricityOutputID FROM T_ElectricityOutput o JOIN M_Customer c ON o.CustomerID = c.CustomerID WHERE c.CustomerCode = N'KA0021' AND o.ElectricityOutputDate >= '2024-01-01' AND o.ElectricityOutputDate < '2025-01-01'";
  const agent = [call('list_workflows', {}), call('search_schema', { query: 'hóa đơn điện' }), call('execute_sql_query', { sql: unfiltered }), call('execute_sql_query', { sql: filtered })];
  const result = await new Harness({ toolManager: manager, dispatch: async (_provider, _messages, definitions) => {
    if (definitions[0]?.function?.name === 'resolve_conversation') return call('resolve_conversation', { relation: 'followup', operation: 'list', cardinality: 'collection',
      attributes: [], selectedIds: [], clarification: '', dataUse: 'current', scopeAction: 'revise' });
    return agent.shift() || { content: 'Có 1 hóa đơn.' };
  } }).run({ userMessage: 'vậy tìm trong năm 2024 đi', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, dbSourceId: 'fixture', mode: 'data',
      resolutionContext: { candidates: [], recent: [{ role: 'user', content: 'Phát hiện tháng tiêu thụ điện bất thường của KA0021' }],
        previousRequest: { operation: 'analyze', businessState: { table: 'T_ElectricityOutput', requestFilters: [{ table: 'M_Customer', column: 'CustomerCode', value: 'KA0021', schemaName: 'dbo' }] } } },
      requestPlan: { table: 'T_ElectricityOutput', intent: 'list', schemaColumns: ['ElectricityOutputID'], outputs: { data: true }, schemaScope: { filters: [] },
        conversationState: { operation: 'list', requestedAttributes: [] } } } });
  assert.ok(result.trace.steps.some(step => step.type === 'REQUEST_FILTERS_INHERITED'));
  assert.deepEqual(executed, [filtered]);
  assert.ok(result.toolCalls.some(item => item.code === 'REQUEST_FILTER_REQUIRED'));
  assert.match(result.replyText, /Giữ phạm vi từ câu trước: \*\*KA0021\*\*/);
});
