'use strict';
// Approved business metrics reach the v2 contract: the catalog offers those
// whose table, measure and date are visible, the compiler expands a metric to
// its column, aggregation, name and fixed conditions, and the governed metric
// tool applies the same conditions.
const test = require('node:test');
const assert = require('node:assert/strict');
const catalogApi = require('../src/backend/agent_core/pipeline/query_catalog');
const { compile, metricRoot } = require('../src/backend/agent_core/pipeline/query_compiler');
const governed = require('../src/backend/governance/metrics');
const { computeMetrics } = require('../src/backend/training_core/pipeline_metrics');

const column = (columnName, dataType, displayName = '', isPrimaryKey = false) => ({ columnName, dataType, displayName, isPrimaryKey });
const tables = [
  { tableId: 's::T_ElectricityOutput', tableName: 'T_ElectricityOutput', schemaName: 'dbo', dbSourceId: 's', isActive: true,
    columns: [column('ElectricityOutputID', 'INT', 'ID chứng từ', true), column('ElectricityOutputDate', 'DATETIME', 'Ngày chứng từ'),
      column('CustomerID', 'INT'), column('PreTotalAmount', 'FLOAT', 'Tiền trước thuế'), column('FinalTotalAmount', 'FLOAT', 'Tiền sau thuế'),
      { ...column('HoUID', 'SMALLINT'), isVisible: false }, column('Secret', 'FLOAT')] },
  { tableId: 's::M_Customer', tableName: 'M_Customer', schemaName: 'dbo', dbSourceId: 's', isActive: true,
    columns: [column('CustomerID', 'INT', '', true), column('CustomerCode', 'NVARCHAR', 'Mã khách hàng')] }
];
const relation = { id: 'r-customer', sourceTable: 'T_ElectricityOutput', targetTable: 'M_Customer', cardinality: 'many-to-one',
  columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'CustomerID' }], businessRole: 'Khách hàng', displayColumn: 'CustomerCode' };
const metric = (metricId, valueColumn, extra = {}) => ({ metricId, version: 1, owner: 'Kế toán', definition: metricId, table: 'dbo.T_ElectricityOutput',
  valueColumn, aggregation: 'SUM', unit: 'VNĐ', grain: 'chứng từ', timeColumn: 'ElectricityOutputDate', timezone: 'Asia/Ho_Chi_Minh',
  dimensions: ['CustomerID'], nullRule: 'exclude', rounding: 0, approved: true, sourceId: 's', ...extra });
const definitions = [
  metric('bill_after_tax', 'FinalTotalAmount', { label: 'Tiền hóa đơn sau thuế', aliases: ['tiền điện sau thuế'] }),
  metric('bill_count', 'ElectricityOutputID', { aggregation: 'COUNT', label: 'Số hóa đơn', unit: 'hóa đơn' }),
  metric('fee_after_tax', 'FinalTotalAmount', { label: 'Phí vận hành', conditions: [{ column: 'HoUID', operator: 'eq', value: 21 }] }),
  metric('blocked_metric', 'FinalTotalAmount', { label: 'Bị chặn', conditions: [{ column: 'Secret', operator: 'notNull' }] }),
  metric('other_source', 'FinalTotalAmount', { sourceId: 'other' })
];
const build = (metrics = definitions.filter(item => item.sourceId === 's')) => catalogApi.build(
  { dbSourceId: 's', tableDirectory: tables.map(table => ({ tableName: table.tableName })), selectedTables: ['T_ElectricityOutput'] },
  { dictionary: { getGroupedTables: () => tables }, relationships: { verifiedRelationships: () => [relation] }, policy: ['Secret'], metrics });
const question = 'Tiền điện sau thuế của KA0021 trong 2024-02 là bao nhiêu?';
const filters = [{ ref: 'T_ElectricityOutput.CustomerID->CustomerCode', operator: 'eq', value: 'KA0021', evidence: 'KA0021' },
  { ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-02', evidence: '2024-02' }];

test('the catalog offers visible metrics of the source and describes them to the contract', () => {
  const catalog = build();
  assert.deepEqual(catalog.metrics.map(item => item.id), ['bill_after_tax', 'bill_count', 'fee_after_tax']);
  const text = catalogApi.describe(catalog);
  assert.match(text, /bill_after_tax "Tiền hóa đơn sau thuế" = SUM\(T_ElectricityOutput\.FinalTotalAmount\) \(VNĐ; date: ElectricityOutputDate; also: tiền điện sau thuế\)/);
  assert.match(text, /fee_after_tax "Phí vận hành" = SUM\(T_ElectricityOutput\.FinalTotalAmount\) WHERE \[HoUID\] = 21/);
  assert.equal(build([]).metrics.length, 0);
});

test('a metric measure compiles to its column, name and lineage', () => {
  const result = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }], filters }, build(), { question });
  assert.match(result.sql, /SUM\(t0\.\[FinalTotalAmount\]\) AS \[Tiền hóa đơn sau thuế\]/);
  assert.deepEqual(result.metrics, [{ id: 'bill_after_tax', version: 1 }]);
  assert.equal(result.outputs[0].unit, 'VNĐ');
});

test('a raw measure equal to an unconditioned metric is that metric; other measures stay raw', () => {
  const catalog = build();
  const same = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ ref: 'T_ElectricityOutput.FinalTotalAmount', aggregation: 'SUM' }], filters }, catalog, { question });
  assert.deepEqual(same.metrics, [{ id: 'bill_after_tax', version: 1 }]);
  const count = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ ref: '*', aggregation: 'COUNT' }], filters }, catalog, { question });
  assert.deepEqual(count.metrics, [{ id: 'bill_count', version: 1 }]);
  assert.match(count.sql, /COUNT\(t0\.\[ElectricityOutputID\]\) AS \[Số hóa đơn\]/);
  const other = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ ref: 'T_ElectricityOutput.PreTotalAmount', aggregation: 'SUM' }], filters }, catalog, { question });
  assert.deepEqual(other.metrics, []);
  // "metric": "COUNT" is a record count, and as such the approved count metric.
  const named = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'COUNT', ref: '*' }], filters }, catalog, { question });
  assert.deepEqual(named.metrics, [{ id: 'bill_count', version: 1 }]);
  assert.equal(named.sql, count.sql);
});

test('fixed conditions filter the rows of a single metric, and only their own measure otherwise', () => {
  const catalog = build();
  const single = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'fee_after_tax' }], filters }, catalog, { question });
  assert.match(single.sql, /WHERE .*t0\.\[HoUID\] = 21/);
  assert.match(single.scope.join('; '), /Phí vận hành: theo định nghĩa chỉ tiêu \(\[HoUID\] = 21\)/);
  const mixed = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }, { metric: 'fee_after_tax' }], filters }, catalog, { question });
  assert.match(mixed.sql, /SUM\(CASE WHEN t0\.\[HoUID\] = 21 THEN t0\.\[FinalTotalAmount\] END\) AS \[Phí vận hành\]/);
  assert.ok(!/WHERE[^]*HoUID/.test(mixed.sql.replace(/CASE WHEN[^]*?END/g, '')));
});

test('unknown metrics, metrics of another table and empty measures are rejected for repair', () => {
  const catalog = build();
  assert.throws(() => compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'nope' }] }, catalog), { code: 'V2_METRIC_UNKNOWN' });
  assert.throws(() => compile({ root: 'M_Customer', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }] }, catalog), { code: 'V2_METRIC_ROOT' });
  assert.throws(() => compile({ root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ label: 'x' }] }, catalog), { code: 'V2_MEASURE_INVALID' });
});

test('the governed metric tool applies the same fixed conditions', () => {
  const definition = metric('fee_after_tax', 'FinalTotalAmount', { conditions: [{ column: 'HoUID', operator: 'in', values: [21, 22] }, { column: 'Note', operator: 'ne', value: "O'Neil" }] });
  const { sql } = governed.compile(definition, { start: '2024-01-01', end: '2024-02-01' });
  assert.match(sql, / AND \[HoUID\] IN \(21, 22\) AND \(\[Note\] <> N'O''Neil' OR \[Note\] IS NULL\)/);
  const { sourceId, version, ...stored } = definition;
  assert.equal(governed.validate(stored), true);
  assert.equal(governed.validate({ ...stored, conditions: [{ column: 'HoUID', operator: 'like', value: 1 }] }), false);
});

// One v2 request whose planner always returns `contract`.
async function runV2(t, contract) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => tables);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => [relation]);
  t.mock.method(governed, 'list', () => definitions);
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), queries = [], prompts = [];
  const register = (name, handler) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = handler; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['T_ElectricityOutput'],
    tableDirectory: tables.map(table => ({ tableName: table.tableName })), intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => { queries.push(args.sql); return { sql: args.sql, rows: [{ 'Tiền hóa đơn sau thuế': 6652704 }] }; });
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, messages, definitions) => {
    if (definitions[0]?.function?.name !== 'plan_query') return { content: 'ok' };
    prompts.push(messages.at(-1).content);
    return { tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify(contract) } }] };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'], context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } } } });
  return { result, queries, prompts };
}

test('v2 answers an aggregate through an approved metric and says so in the method', async t => {
  const { result, queries, prompts } = await runV2(t, { kind: 'data', root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }], filters });
  assert.match(prompts[0], /METRICS \(approved business definitions\):\n  bill_after_tax "Tiền hóa đơn sau thuế"/);
  assert.match(queries.at(-1), /SUM\(t0\.\[FinalTotalAmount\]\) AS \[Tiền hóa đơn sau thuế\]/);
  assert.match(result.replyText, /Tiền hóa đơn sau thuế theo chỉ tiêu đã duyệt \(SUM\(FinalTotalAmount\), đơn vị VNĐ\)/);
  assert.match(result.replyText, /6\.652\.704/);
  assert.deepEqual(result.trace.steps.find(step => step.type === 'V2_COMPILED').metrics, [{ id: 'bill_after_tax', version: 1 }]);
});

test('a contract measuring only metrics of one table takes that table as root; anything else is left alone', () => {
  const catalog = build();
  assert.equal(metricRoot({ measures: [{ metric: 'bill_after_tax' }, { metric: 'bill_count' }] }, catalog), 'T_ElectricityOutput');
  assert.equal(metricRoot({ root: 'M_Customer', measures: [{ metric: 'bill_after_tax' }] }, catalog), null);
  assert.equal(metricRoot({ measures: [{ metric: 'bill_after_tax' }, { ref: 'T_ElectricityOutput.PreTotalAmount', aggregation: 'SUM' }] }, catalog), null);
  assert.equal(metricRoot({ measures: [{ metric: 'nope' }] }, catalog), null);
  assert.equal(metricRoot({ fields: ['T_ElectricityOutput.FinalTotalAmount'] }, catalog), null);
  const twoTables = { metrics: [{ id: 'a', table: 'T_ElectricityOutput' }, { id: 'b', table: 'T_Revenue' }] };
  assert.equal(metricRoot({ measures: [{ metric: 'a' }, { metric: 'b' }] }, twoTables), null);
  const compiled = compile({ operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }], filters }, catalog, { question });
  assert.equal(compiled.root, 'T_ElectricityOutput');
  assert.throws(() => compile({ root: 'M_Customer', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }] }, catalog), { code: 'V2_METRIC_ROOT' });
});

test('v2 fills the root from the metric instead of spending a repair call, and still checks the filters', async t => {
  const { result, queries, prompts } = await runV2(t, { kind: 'data', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }], filters });
  assert.equal(prompts.length, 1);
  assert.ok(!result.trace.steps.some(step => step.type === 'V2_CONTRACT_REJECTED'));
  assert.deepEqual(result.trace.steps.find(step => step.type === 'V2_ROOT_FROM_METRIC'), { type: 'V2_ROOT_FROM_METRIC', root: 'T_ElectricityOutput' });
  assert.match(queries.at(-1), /FROM \[dbo\]\.\[T_ElectricityOutput\] t0/);
  assert.match(queries.at(-1), /t1\.\[CustomerCode\] = N'KA0021'/);
  // A dropped criterion is still rejected: the inferred root does not skip coverage.
  const dropped = await runV2(t, { kind: 'data', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }], filters: [filters[1]] });
  assert.equal(dropped.result.trace.steps.find(step => step.type === 'V2_CONTRACT_REJECTED')?.code, 'V2_CRITERION_DROPPED');
});

test('the pipeline report counts v2 aggregates answered through approved metrics', () => {
  const record = (id, metrics, operation = 'aggregate') => ({ id, timestamp: '2026-10-26T01:00:00Z', status: 'SUCCESS',
    requestPayload: { sessionId: 's1', diagnostics: { pipeline: 'v2', steps: [{ type: 'V2_COMPILED', operation, metrics }] } } });
  const result = computeMetrics([record('a', ['bill_after_tax']), record('b', []), record('c', [], 'list')]);
  assert.equal(result.v2Era.metricShare, 0.5);
  assert.deepEqual(result.metrics.map(item => item.name).sort(), ['(không qua chỉ tiêu)', 'bill_after_tax']);
});
