'use strict';
// Forecasts in the v2 pipeline: target months, the code-computed projection,
// the "N tháng tới" clock, and a forecast over two flows end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const forecast = require('../src/backend/agent/pipeline/forecast');

const month = text => Number(text.slice(0, 4)) * 12 + Number(text.slice(5, 7)) - 1;
const label = value => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;

test('forecast months are read from the question, with or without a year', () => {
  assert.deepEqual(forecast.targets('dự báo cho tháng 3,4').months, [{ month: 3, year: null }, { month: 4, year: null }]);
  assert.deepEqual(forecast.targets('dự báo tháng 3 và tháng 4 sẽ xài điện bao nhiêu').months.map(item => item.month), [3, 4]);
  assert.deepEqual(forecast.targets('dự báo tháng 3-5/2025').months, [3, 4, 5].map(value => ({ month: value, year: 2025 })));
  const ahead = forecast.targets('phân tích và dự báo điện mua vào và bán ra cho 3 tháng tới');
  assert.equal(ahead.upcoming, 3);
  assert.deepEqual(ahead.months, []);
  assert.deepEqual(ahead.phrases, ['3 thang toi']);
  assert.equal(forecast.asked('dự  báo tháng 3'), true);
  assert.equal(forecast.asked('phân tích điện'), false);
});

test('months without a year follow the data; "N tháng tới" counts from today', () => {
  const last = month('2024-02');
  assert.deepEqual(forecast.resolveTargets(forecast.targets('dự báo cho tháng 3,4'), last, '2026-10-30').map(label), ['2024-03', '2024-04']);
  assert.deepEqual(forecast.resolveTargets(forecast.targets('dự báo tháng 1'), last, '2026-10-30').map(label), ['2025-01']);
  assert.deepEqual(forecast.resolveTargets(forecast.targets('dự báo 3 tháng tới'), last, '2026-10-30').map(label), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(forecast.resolveTargets(forecast.targets('dự báo điện'), last, '2026-10-30').map(label), ['2024-03', '2024-04', '2024-05']);
});

test('a short history is averaged, a longer one follows its trend', () => {
  const short = forecast.project([{ x: 1, value: 40 }, { x: 2, value: 20 }], 3);
  assert.deepEqual(short, { method: 'mean', value: 30, low: 20, high: 40 });
  const points = Array.from({ length: 8 }, (_, i) => ({ x: i, value: 100 + 10 * i }));
  const long = forecast.project(points, 8);
  assert.equal(long.method, 'trend');
  assert.ok(Math.abs(long.value - 180) < 1e-9);
  assert.ok(Math.abs(long.slope - 10) < 1e-9);
  // A falling trend never forecasts a negative amount.
  assert.equal(forecast.project(points.map(point => ({ x: point.x, value: 70 - 10 * point.x })), 20).value, 0);
});

test('the forecast months are dropped from the filters and the history is grouped by month', () => {
  const catalog = { tables: new Map([['tin', { tableName: 'TIn', dateColumn: 'InDate', columns: new Map() }]]), relations: [],
    metrics: [{ id: 'in_qty', table: 'TIn', column: 'Qty', dateColumn: 'InDate', aggregation: 'SUM', conditions: [], aliases: [] }] };
  const contract = { kind: 'data', root: 'TIn', operation: 'aggregate', measures: [{ metric: 'in_qty' }], analysis: 'forecast', filters: [
    { ref: 'TIn.InDate', operator: 'gte', value: '2026-08-01', evidence: '3 tháng tới', inherited: true },
    { ref: 'TIn.InDate', operator: 'period', value: '2024', evidence: 'năm 2024' }] };
  const changes = forecast.prepare(contract, catalog, ['phân tích và dự báo điện', 'dự báo điện cho 3 tháng tới']);
  assert.deepEqual(contract.filters.map(filter => filter.evidence), ['năm 2024'], 'a history limit stays');
  assert.deepEqual(contract.groupBy, [{ ref: 'TIn.InDate', grain: 'month' }]);
  assert.deepEqual(changes, ['dropped:TIn.InDate', 'groupBy:TIn.InDate']);
});

test('the request clock reads "3 tháng tới" ahead of today, not as the last 3 months', () => {
  const clock = require('../src/backend/services/request_time');
  const now = new Date('2026-10-30T06:00:00Z');
  const ahead = clock.create('dự báo điện cho 3 tháng tới', now);
  assert.equal(ahead.monthWindow, undefined);
  assert.deepEqual(ahead.upcomingMonths, { start: '2026-10-30', end: '2027-01-30', count: 3 });
  assert.ok(ahead.allowedDates.includes('2027-01-30'));
  assert.equal(clock.create('hợp đồng hết hạn 1 tháng tới', new Date('2026-01-31T06:00:00Z')).upcomingMonths.end, '2026-02-28');
  assert.equal(clock.create('doanh số 3 tháng', now).monthWindow.start, '2026-08-01');
});

// Two flows (purchase and sale) on two tables with approved metrics.
const tables = [
  { tableId: 's::tin', tableName: 'TIn', schemaName: 'dbo', dbSourceId: 's', isActive: true, defaultTimeColumn: 'InDate', semanticModel: { entity: 'Điện mua vào' },
    columns: [{ columnName: 'InID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'InDate', dataType: 'DATETIME', displayName: 'Ngày mua' }, { columnName: 'Qty', dataType: 'FLOAT', displayName: 'Sản lượng' }] },
  { tableId: 's::tout', tableName: 'TOut', schemaName: 'dbo', dbSourceId: 's', isActive: true, defaultTimeColumn: 'OutDate', semanticModel: { entity: 'Điện bán ra' },
    columns: [{ columnName: 'OutID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'OutDate', dataType: 'DATETIME', displayName: 'Ngày bán' }, { columnName: 'Qty', dataType: 'FLOAT', displayName: 'Sản lượng' }] }];
const metrics = [
  { metricId: 'in_qty', sourceId: 's', table: 'dbo.TIn', valueColumn: 'Qty', timeColumn: 'InDate', aggregation: 'SUM', label: 'Sản lượng điện mua vào', unit: 'kWh', aliases: [], conditions: [], version: 1 },
  { metricId: 'out_qty', sourceId: 's', table: 'dbo.TOut', valueColumn: 'Qty', timeColumn: 'OutDate', aggregation: 'SUM', label: 'Sản lượng điện bán ra', unit: 'kWh', aliases: [], conditions: [], version: 1 }];
const call = (name, args) => ({ tool_calls: [{ id: `${name}-1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function run(t, { question, contracts, rows, turns = [], answers = [], selected = ['TIn', 'TOut'] }) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => tables);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  t.mock.method(require('../src/backend/governance/metrics'), 'list', () => metrics);
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent/tools/base_tool');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const manager = new Manager(), seen = { sql: [], prompts: [] };
  const register = (name, handler) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = handler; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: selected, tableDirectory: [{ tableName: 'TIn' }, { tableName: 'TOut' }], intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => { seen.sql.push(args.sql); return { sql: args.sql, rows: /\[TOut\]/.test(args.sql) ? rows.out : rows.in }; });
  const pending = [...contracts], pendingAnswers = [...answers];
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, messages, definitions) => {
    seen.prompts.push({ tool: definitions[0]?.function?.name || null, messages });
    if (definitions[0]?.function?.name === 'plan_query') return call('plan_query', pending.shift());
    return { content: pendingAnswers.shift() || '' };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'],
    context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } },
      resolutionContext: { candidates: [], recent: [], turns } } });
  return { result, seen };
}
const monthRow = (date, alias, value) => ({ 'Tháng': new Date(`${date}-01T00:00:00Z`), [alias]: value });

test('a forecast follow-up answered as chat is repaired into data and projected from the history', async t => {
  const previous = { question: 'phân tích và dự báo điện', status: 'SUCCESS', dbSourceId: 's',
    contract: { kind: 'data', root: 'TIn', operation: 'aggregate', measures: [{ metric: 'in_qty' }], groupBy: [{ ref: 'TIn.InDate', grain: 'month' }], analysis: 'anomaly' },
    result: { rowCount: 2, columns: ['Tháng', 'Sản lượng điện mua vào'], preview: [['2024-01-01', 40085700], ['2024-02-01', 22952700]] } };
  const { result, seen } = await run(t, { question: 'dự báo cho tháng 3,4', turns: [previous],
    rows: { in: [monthRow('2024-01', 'Sản lượng điện mua vào', 40085700), monthRow('2024-02', 'Sản lượng điện mua vào', 22952700)] },
    contracts: [{ kind: 'chat' }, { kind: 'data', followup: true, filters: [{ ref: 'TIn.InDate', operator: 'gte', value: '2024-03-01', evidence: 'tháng 3,4' }] }] });
  const repair = seen.prompts.filter(prompt => prompt.tool === 'plan_query').at(-1).messages.at(-1).content;
  assert.match(repair, /V2_FORECAST_NEEDS_DATA/);
  assert.equal(seen.sql.length, 1);
  assert.doesNotMatch(seen.sql[0], /WHERE/, 'the forecast months do not filter the history');
  assert.match(result.replyText, /\*\*Dự báo 03\/2024 – 04\/2024\*\*/);
  assert.match(result.replyText, /\| 03\/2024 \| 31\.519\.200 \(22\.952\.700 – 40\.085\.700\) \|/);
  assert.match(result.replyText, /\*\*Cách ước tính:\*\* trung bình 2 tháng có số liệu \(01\/2024 – 02\/2024\)/);
  assert.match(result.replyText, /\*\*Độ tin cậy:\*\* thấp/);
  assert.match(result.replyText, /\*\*Số liệu thực tế dùng để dự báo:\*\*/);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_FORECAST_REQUESTED' && step.from === 'anomaly'));
  assert.equal(result.trace.pipeline, 'v2');
});

test('purchase and sale are forecast together; "3 tháng tới" far after the data is said plainly', async t => {
  const { result, seen } = await run(t, { question: 'phân tích và dự báo điện mua vào và bán ra cho 3 tháng tới',
    rows: { in: [monthRow('2024-01', 'Sản lượng điện mua vào', 40), monthRow('2024-02', 'Sản lượng điện mua vào', 20)],
      out: [monthRow('2024-01', 'Sản lượng điện bán ra', 30), monthRow('2024-02', 'Sản lượng điện bán ra', 10)] },
    contracts: [{ kind: 'data', root: 'TIn', operation: 'aggregate', analysis: 'anomaly', measures: [{ metric: 'in_qty' }],
      groupBy: [{ ref: 'TIn.InDate', grain: 'month' }], also: [{ root: 'TOut', measures: [{ metric: 'out_qty' }] }],
      filters: [{ ref: 'TIn.InDate', operator: 'gte', value: '2026-08-01', evidence: '3 tháng tới' }, { ref: 'TIn.InDate', operator: 'lt', value: '2026-11-01', evidence: '3 tháng tới' }] }] });
  assert.equal(seen.sql.length, 2);
  assert.ok(seen.sql.every(sql => !/WHERE/.test(sql)));
  assert.match(seen.sql[1], /DATEFROMPARTS\(YEAR\(t0\.\[OutDate\]\)/, 'the sale flow groups by its own business date');
  assert.ok(result.replyText.indexOf('**Điện mua vào**') < result.replyText.indexOf('**Điện bán ra**'));
  assert.match(result.replyText, /\| 03\/2024 \| 30 \(20 – 40\) \|/);
  assert.match(result.replyText, /\| 03\/2024 \| 20 \(10 – 30\) \|/);
  assert.match(result.replyText, /Dữ liệu chỉ có đến 02\/2024/);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_ALSO_EXECUTED'));
});

test('a second flow on a table retrieval did not select loads it for the repair round', async t => {
  const { result, seen } = await run(t, { question: 'dự báo điện mua vào và bán ra', selected: ['TOut'],
    rows: { in: [monthRow('2024-01', 'Tổng Sản lượng', 40), monthRow('2024-02', 'Tổng Sản lượng', 20)],
      out: [monthRow('2024-01', 'Sản lượng điện bán ra', 30), monthRow('2024-02', 'Sản lượng điện bán ra', 10)] },
    contracts: [
      { kind: 'data', operation: 'aggregate', analysis: 'forecast', months: 3, measures: [{ metric: 'out_qty' }] },
      { kind: 'data', operation: 'aggregate', analysis: 'forecast', measures: [{ metric: 'out_qty' }], also: [{ root: 'TIn', measures: [{ ref: 'TIn.Qty', aggregation: 'SUM' }] }] },
      { kind: 'data', operation: 'aggregate', analysis: 'forecast', measures: [{ metric: 'out_qty' }], also: [{ root: 'TIn', measures: [{ metric: 'in_qty' }] }] }] });
  const repairs = seen.prompts.filter(prompt => prompt.tool === 'plan_query').slice(1).map(prompt => prompt.messages.at(-1).content);
  assert.match(repairs[0], /must NOT have additional properties \(months\)/, 'the repair names the unknown property');
  assert.match(repairs[1], /V2_ROOT_UNKNOWN: TIn[\s\S]*Additional catalog:[\s\S]*TABLE TIn/);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_CATALOG_EXTENDED'));
  assert.equal(seen.sql.length, 2);
  assert.match(result.replyText, /\*\*Điện bán ra\*\*[\s\S]*\*\*Điện mua vào\*\*/);
});
