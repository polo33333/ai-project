'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessSqlEvidence, dropsAggregateScope } = require('../src/backend/agent/harness/completion_policy');
const { protect } = require('../src/backend/storage/postgres/crypto');
const groups = require('../src/backend/agent/harness/semantic_groups');
const call = sql => ({ toolName: 'execute_sql_query', success: true, args: { sql }, result: { sql, rows: [{ Total: 123 }] } });
const plan = { table: 'Invoices', intent: 'aggregate', metric: 'Amount', aggregation: 'SUM', conversationState: { operation: 'aggregate' } };

test('aggregate evidence must project the requested measure and aggregation', () => {
  for (const sql of [
    'SELECT SUM(OtherAmount) AS Amount FROM Invoices',
    'SELECT COUNT(Amount) AS Total FROM Invoices',
    'SELECT SUM(OtherAmount) AS Total FROM Invoices WHERE Amount > 0',
    'SELECT SUM(OtherAmount) AS Total FROM Invoices -- SUM(Amount)',
    'SELECT SUM(Amount * 2) AS Total FROM Invoices'
  ]) assert.equal(assessSqlEvidence(call(sql), plan).accepted, false, sql);
  for (const sql of ['SELECT SUM(Amount) AS Total FROM Invoices', 'SELECT SUM(i.[Amount]) AS Total FROM Invoices i']) {
    assert.equal(assessSqlEvidence(call(sql), plan).accepted, true, sql);
  }
  assert.equal(assessSqlEvidence(call('SELECT SUM(i.Amount) AS Total FROM Invoices i'), { ...plan, metric: 'Invoices.Amount' }).accepted, true);
});

test('JOIN aggregate repairs preserve physical-table predicates across alias changes', () => {
  const scoped = call("SELECT SUM(i.Amount) FROM Invoices i JOIN Customers c ON i.CustomerID=c.CustomerID WHERE c.Code='SYNTHETIC'");
  assert.equal(dropsAggregateScope('SELECT SUM(a.Amount) FROM Invoices a JOIN Customers b ON a.CustomerID=b.CustomerID', [scoped]), true);
  assert.equal(dropsAggregateScope("SELECT SUM(a.Amount) FROM Invoices a JOIN Customers b ON a.CustomerID=b.CustomerID WHERE b.Code='SYNTHETIC'", [scoped]), false);
  assert.equal(dropsAggregateScope("SELECT SUM(i.Amount) FROM Invoices i JOIN Customers c ON i.CustomerID=c.CustomerID WHERE i.Code='SYNTHETIC'", [scoped]), true);
});

test('storage protection round-trips dates in nested SQL evidence', () => {
  const value = { rows: [{ DocDate: new Date('2026-10-23T00:00:00Z'), Missing: null }], label: 'audit' };
  const wire = JSON.parse(JSON.stringify(protect(value, 'audit')));
  assert.deepEqual(protect(wire, 'audit', true), JSON.parse(JSON.stringify(value)));
});

test('semantic groups use latest qualified evidence without replacing it with failures', () => {
  const first = { ...call('SELECT SUM(Amount) FROM Invoices'), semanticGroup: 0 };
  const corrected = { ...first, result: { ...first.result, rows: [{ Total: 456 }] } };
  const invalid = { ...call('SELECT SUM(OtherAmount) FROM Invoices'), semanticGroup: 0 };
  const failed = { ...first, success: false };
  const accept = candidate => assessSqlEvidence(candidate, plan).accepted;
  assert.equal(groups.results([{ label: 'Total' }], [first, corrected, invalid, failed], accept)[0].call, corrected);
  assert.equal(groups.results([{ label: 'Total' }], [invalid], accept)[0].complete, false);
  assert.equal(groups.results([{ label: 'Total' }], [{ ...corrected, superseded: true }], accept)[0].complete, false);
});

test('configured per-1K token price enforces cost admission before network dispatch', async () => {
  const { RequestExecutionBudget } = require('../src/backend/agent/harness/request_execution_budget');
  const { dispatchToProvider } = require('../src/backend/assistant/adapters');
  const budget = new RequestExecutionBudget({ maxCost: 0.001, maxTokens: 20000 });
  await assert.rejects(dispatchToProvider({ tokenCost: 1 }, [], [], undefined, { executionBudget: budget }),
    { code: 'COST_BUDGET_EXCEEDED' });
  assert.equal(budget.reservations.size, 0);
});
