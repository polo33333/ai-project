'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectUserFacingSqlExecutions } = require('../src/backend/utils/chat_result_selector');

const attempts = [
  { index: 1, sql: 'SELECT exploratory', rows: [{ Month: '2024-07' }], success: true },
  { index: 2, sql: 'SELECT primary', rows: [{ Period: '2024-02' }], success: true }
];

test('chart responses expose only the final successful SQL dataset', () => {
  assert.deepEqual(selectUserFacingSqlExecutions(attempts, { hasChart: true }), [attempts[1]]);
});

test('export responses expose only the final successful SQL dataset', () => {
  assert.deepEqual(selectUserFacingSqlExecutions(attempts, { hasExport: true }), [attempts[1]]);
});

test('ordinary multi-query responses retain all result tables', () => {
  assert.deepEqual(selectUserFacingSqlExecutions(attempts), attempts);
});

test('failed trailing SQL is not selected as the primary dataset', () => {
  const failedLast = [...attempts, { index: 3, success: false, error: 'bad query' }];
  assert.deepEqual(selectUserFacingSqlExecutions(failedLast, { hasChart: true }), [attempts[1]]);
});
