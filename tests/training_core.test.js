'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestPlan, evaluateSql, evaluateResponse, classifyCase, suggestionForFailure, suggestForCase } = require('../src/backend/training_core');

const dictionaryTables = [{
  tableName: 'T_ElectricityOutput',
  columns: [
    { columnName: 'ElectricityOutputDate', dataType: 'datetime' },
    { columnName: 'TotalQty', dataType: 'decimal' },
    { columnName: 'PowerMoney', dataType: 'decimal' }
  ]
}];

test('calendar-relative months never authorize substitution with available months', () => {
  for (const question of ['sản lượng 3 tháng tính đến hôm nay', 'doanh thu tháng này']) {
    assert.equal(createRequestPlan({ question }).allowLatestAvailableMonths, false);
  }
  assert.equal(createRequestPlan({ question: 'doanh thu 7 tháng gần nhất' }).allowLatestAvailableMonths, true);
  assert.equal(createRequestPlan({ question: 'sản lượng 7 tháng gần nhất có dữ liệu' }).allowLatestAvailableMonths, true);
});

test('unconfirmed tool execution cannot satisfy response requirements', () => {
  const result = evaluateResponse({ reply: 'Đã lấy dữ liệu.', plan: { outputs: { data: true } }, toolCalls: [{ toolName: 'execute_sql_query' }] });
  assert.deepEqual(result.failures, ['MISSING_SQL']);
});

test('planner prefers configured customer domain over the first retrieved company table', () => {
  const input = {
    question: 'ds khách hàng', selectedTables: ['M_Company', 'M_Customer'],
    dictionaryTables: [
      { tableName: 'M_Company', columns: [] },
      { tableName: 'M_Customer', domain: 'customer', columns: [] }
    ], domainAliases: { customer: ['khách hàng', 'kh'] }
  };
  const plan = createRequestPlan(input);
  assert.equal(plan.table, 'M_Customer');
  assert.equal(evaluateSql('SELECT CustomerCode, CustomerName FROM M_Customer', plan).valid, true);
  assert.equal(createRequestPlan({ ...input, question: 'ds kh' }).table, 'M_Customer');
  assert.equal(createRequestPlan({ ...input, question: 'ds M_Company của khách hàng' }).table, 'M_Company');
  assert.equal(createRequestPlan({ ...input, question: 'ds khác' }).table, 'M_Company');
});

test('planner supports custom domain names and limits selection to retrieved tables', () => {
  const input = {
    question: 'liệt kê thiết bị', selectedTables: ['First', 'Assets'],
    dictionaryTables: [{ tableName: 'First', columns: [] }, { tableName: 'Assets', domain: 'asset_management', columns: [] }],
    domainAliases: { asset_management: ['thiết bị'] }
  };
  assert.equal(createRequestPlan(input).table, 'Assets');
  assert.equal(createRequestPlan({ ...input, selectedTables: ['First'] }).table, 'First');
  assert.equal(createRequestPlan({ ...input, domainAliases: {} }).table, 'First');
});

test('training core creates a structured time-series plan', () => {
  const plan = createRequestPlan({
    question: 'vẽ biểu đồ TotalQty trong 7 tháng theo ElectricityOutputDate và gửi file',
    selectedTables: ['T_ElectricityOutput'],
    dictionaryTables
  });
  assert.equal(plan.table, 'T_ElectricityOutput');
  assert.equal(plan.metric, 'TotalQty');
  assert.equal(plan.timeColumn, 'ElectricityOutputDate');
  assert.deepEqual(plan.outputs, { data: true, chart: true, export: true });
});

test('planner infers quantity metric and business date for a natural time-series request', () => {
  const plan = createRequestPlan({
    question: 'vẽ biểu đồ sản lượng điện bán ra trong 7 tháng gần nhất và xuất file cho tôi',
    selectedTables: ['T_ElectricityOutput'], dictionaryTables,
    domainAliases: { electricity: ['điện'] }
  });
  assert.equal(plan.metric, 'TotalQty');
  assert.equal(plan.timeColumn, 'ElectricityOutputDate');
  assert.equal(plan.allowLatestAvailableMonths, true);
});

test('planner uses configured defaults before heuristic fallback', () => {
  const plan = createRequestPlan({
    question: 'vẽ biểu đồ chỉ số 6 tháng gần nhất', selectedTables: ['Measurements'],
    dictionaryTables: [{ tableName: 'Measurements', defaultMetric: 'NetValue', defaultTimeColumn: 'RecordedAt', defaultAggregation: 'AVG', columns: [
      { columnName: 'Quantity', dataType: 'decimal' }, { columnName: 'NetValue', dataType: 'decimal' },
      { columnName: 'CreatedDate', dataType: 'datetime' }, { columnName: 'RecordedAt', dataType: 'datetime' }
    ] }], domainAliases: {}
  });
  assert.equal(plan.metric, 'NetValue');
  assert.equal(plan.timeColumn, 'RecordedAt');
  assert.equal(plan.aggregation, 'AVG');
  assert.equal(evaluateSql("SELECT FORMAT(RecordedAt,'yyyy-MM'), AVG(NetValue) FROM Measurements GROUP BY FORMAT(RecordedAt,'yyyy-MM')", plan).valid, true);
  assert.equal(evaluateSql("SELECT FORMAT(RecordedAt,'yyyy-MM'), SUM(NetValue) FROM Measurements GROUP BY FORMAT(RecordedAt,'yyyy-MM')", plan).valid, false);
});

test('customer list rejects company columns and invented filters but accepts valid aliases', () => {
  const plan = createRequestPlan({ question: 'ds khách hàng', selectedTables: ['M_Customer'],
    dictionaryTables: [{ tableName: 'M_Customer', domain: 'customer', columns: ['CustomerID', 'CustomerName', 'IsActive'].map(columnName => ({ columnName })) }],
    domainAliases: { customer: ['khách hàng'] } });
  assert.equal(plan.unfilteredList, true);
  assert.ok(evaluateSql('SELECT TOP 50 CustomerID, CompanyName FROM M_Customer', plan).violations.includes('UNKNOWN_COLUMN:CompanyName'));
  assert.ok(evaluateSql('SELECT CustomerName FROM M_Customer WHERE IsActive = 1', plan).violations.includes('UNREQUESTED_FILTER'));
  assert.equal(evaluateSql('SELECT TOP 50 c.[CustomerName] AS [Name] FROM M_Customer c', plan).valid, true);
  assert.equal(evaluateSql('SELECT CustomerName AS CompanyName FROM M_Customer', plan).valid, true);
});

test('training SQL evaluator rejects a wrong metric', () => {
  const plan = createRequestPlan({
    question: 'vẽ biểu đồ TotalQty trong 7 tháng theo ElectricityOutputDate',
    selectedTables: ['T_ElectricityOutput'],
    dictionaryTables
  });
  const result = evaluateSql("SELECT FORMAT(ElectricityOutputDate,'yyyy-MM'), SUM(PowerMoney) FROM T_ElectricityOutput GROUP BY FORMAT(ElectricityOutputDate,'yyyy-MM')", plan);
  assert.equal(result.valid, false);
  assert.equal(result.violations.some(item => item.includes('TotalQty')), true);
});

test('training response evaluator requires requested output tools', () => {
  const result = evaluateResponse({
    reply: 'Đã có dữ liệu.',
    plan: { outputs: { data: true, chart: true, export: true } },
    toolCalls: [{ toolName: 'execute_sql_query', success: true }]
  });
  assert.deepEqual(result.failures, ['MISSING_CHART', 'MISSING_EXPORT']);
});

test('training response evaluator rejects a truncated data answer', () => {
  const result = evaluateResponse({
    reply: 'D',
    plan: { outputs: { data: true, chart: false, export: false } },
    toolCalls: [{ toolName: 'execute_sql_query', success: true }]
  });
  assert.deepEqual(result.failures, ['INSUFFICIENT_DATA_ANSWER']);
});

test('training response evaluator rejects an answer that reports only SQL row count', () => {
  const result = evaluateResponse({
    reply: 'Đã truy vấn dữ liệu thành công và tìm thấy **1** dòng kết quả.',
    plan: { outputs: { data: true } },
    toolCalls: [{ toolName: 'execute_sql_query', success: true }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.failures.includes('INSUFFICIENT_DATA_ANSWER'));
});

test('failure classifier detects history contamination', () => {
  const failures = classifyCase({
    question: 'vẽ biểu đồ sản lượng điện',
    reply: 'Nhân viên Yên Duy có mã NV004.',
    toolCalls: []
  });
  assert.equal(failures.includes('HISTORY_CONTAMINATION'), true);
});

test('failure classifier exposes memory routing and persistence regressions', () => {
  const topicFailures = classifyCase({
    question: 'sản lượng điện', reply: 'ok', completionStatus: 'SUCCESS',
    memoryDecision: { mode: 'recent', reason: 'same_table_followup', previousScope: 'employee', currentScope: 'electricity' }
  });
  assert.equal(topicFailures.includes('TOPIC_CHANGE_NOT_DETECTED'), true);

  const persistenceFailures = classifyCase({
    question: 'dữ liệu', reply: 'partial', completionStatus: 'PARTIAL', memoryPersisted: true,
    memoryDecision: { mode: 'none', reason: 'missing_reference' }
  });
  assert.equal(persistenceFailures.includes('INVALID_RESPONSE_PERSISTED'), true);
  assert.equal(persistenceFailures.includes('MISSING_REFERENCE'), true);
});

test('suggestion engine returns an actionable recommendation', () => {
  assert.deepEqual(suggestionForFailure('WRONG_METRIC:TotalQty'), {
    target: 'sql',
    action: 'replace_metric',
    title: 'Sửa metric thành TotalQty',
    message: 'Dùng đúng phép tổng hợp trên TotalQty.'
  });
  const suggestions = suggestForCase({ failures: ['MISSING_CHART', 'MISSING_EXPORT'] });
  assert.deepEqual(suggestions.map(item => item.action), ['auto_render_chart', 'auto_export_data']);
});
