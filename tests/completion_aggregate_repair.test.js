'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCompletion, qualifiedSql } = require('../src/backend/agent_core/harness/completion_policy');
const plan = { table: 'Invoices', intent: 'aggregate', schemaColumns: ['Amount', 'CustomerID'],
  outputs: { data: true }, schemaScope: { filters: [] }, conversationState: { operation: 'aggregate' } };
const executed = sql => ({ toolName: 'execute_sql_query', success: true, args: { sql }, result: { sql, rows: [{ Amount: 25 }] } });

test('executed invoice rows require aggregation rather than reporting missing execution', () => {
  const calls = [executed('SELECT Amount FROM Invoices WHERE CustomerID = 4')];
  assert.equal(qualifiedSql(calls, plan).length, 0);
  const evaluation = evaluateCompletion({ reply: 'Invoice amount is 25.', plan, toolCalls: calls });
  assert.deepEqual(evaluation.failures, ['SQL_AGGREGATION_REQUIRED']);
});

test('aggregate repair accepts executed totals and still requires actual successful SQL', () => {
  const calls = [executed('SELECT Amount FROM Invoices WHERE CustomerID = 4'),
    executed('SELECT SUM(Amount) AS Amount FROM Invoices WHERE CustomerID = 4')];
  assert.equal(evaluateCompletion({ reply: 'Total amount is 25.', plan, toolCalls: calls }).valid, true);
  assert.deepEqual(evaluateCompletion({ reply: 'Total amount is 25.', plan, toolCalls: [] }).failures, ['MISSING_SQL']);
  calls[0].success = false;
  assert.deepEqual(evaluateCompletion({ reply: 'Total amount is 25.', plan, toolCalls: calls.slice(0, 1) }).failures, ['SQL_EXECUTION_FAILED']);
});

test('out of scope SQL cannot become aggregate repair evidence', () => {
  const calls = [executed('SELECT Amount FROM Unrelated')];
  assert.deepEqual(evaluateCompletion({ reply: 'Total amount is 25.', plan, toolCalls: calls }).failures, ['SQL_PLAN_WRONG_TABLE', 'SQL_AGGREGATION_REQUIRED']);
});

test('evidence assessment separates source, scope, plan and execution for every data domain', () => {
  const { assessSqlEvidence } = require('../src/backend/agent_core/harness/completion_policy');
  for (const table of ['Invoices', 'Payroll', 'Warehouse']) {
    const scoped = { table, dbSourceId: 'allowed', schemaScope: { filters: [{ table, column: 'Category', value: 2 }] } };
    const valid = executed(`SELECT SUM(Amount) AS Amount FROM ${table} WHERE Category = 2`);
    valid.result.dbSourceId = 'allowed';
    assert.equal(assessSqlEvidence(valid, scoped).accepted, true);
    assert.deepEqual(assessSqlEvidence({ ...valid, result: { ...valid.result, dbSourceId: 'other' } }, scoped).failures, ['SQL_SOURCE_MISMATCH']);
    assert.deepEqual(assessSqlEvidence(executed(`SELECT SUM(Amount) FROM ${table}`), scoped).failures, ['SQL_SCOPE_MISMATCH']);
    assert.deepEqual(assessSqlEvidence(valid, { ...scoped, schemaScope: { invalid: true } }).failures, ['SQL_SCOPE_UNRESOLVED']);
    assert.deepEqual(assessSqlEvidence({ ...valid, result: {} }, scoped).failures, ['SQL_ROWS_UNAVAILABLE']);
    assert.equal(assessSqlEvidence({ ...valid, result: { ...valid.result, rows: [] } }, scoped).accepted, true, 'Empty results are evidence, not a failure to execute');
  }
});
