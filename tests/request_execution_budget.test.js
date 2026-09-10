'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');

test('request budget counts model and SQL attempts independently', () => {
  const budget = new RequestExecutionBudget({ timeoutMs: 10000, maxModelCalls: 2, maxSqlAttempts: 1 });
  budget.consumeModelCall();
  budget.consumeSqlAttempt();
  budget.recordRepair();
  assert.equal(budget.snapshot().modelCalls, 1);
  assert.equal(budget.snapshot().sqlAttempts, 1);
  assert.equal(budget.snapshot().repairAttempts, 1);
  assert.throws(() => budget.consumeSqlAttempt(), error => error.code === 'SQL_BUDGET_EXCEEDED');
  budget.consumeModelCall();
  assert.throws(() => budget.consumeModelCall(), error => error.code === 'LOCAL_MODEL_CALL_BUDGET_EXCEEDED');
});

test('request budget enforces a total deadline', () => {
  const budget = new RequestExecutionBudget({ startedAt: 100, deadlineAt: 100, maxModelCalls: 1, maxSqlAttempts: 1 });
  assert.throws(() => budget.consumeModelCall(), error => error.code === 'LOCAL_REQUEST_DEADLINE_EXCEEDED');
});
