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
