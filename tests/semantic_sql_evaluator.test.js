'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareRows, evaluateCase, validateCorpus, summarize } = require('../scripts/eval/semantic_sql_evaluator');

test('compareRows accepts unordered rows, decimal strings, and projected expected columns', () => {
  const result = compareRows(
    [{ Name: 'B', Total: '20.00', Extra: 1 }, { Name: 'A', Total: 10 }],
    [{ Name: 'A', Total: '10.0' }, { Name: 'B', Total: 20 }]
  );
  assert.equal(result.passed, true);
});

test('compareRows applies numeric tolerance', () => {
  assert.equal(compareRows([{ Value: 10.004 }], [{ Value: 10 }], { numericTolerance: 0.01 }).passed, true);
  assert.equal(compareRows([{ Value: 10.02 }], [{ Value: 10 }], { numericTolerance: 0.01 }).passed, false);
});

test('evaluateCase checks semantic rows, schema selection, and requested artifacts', () => {
  const evaluation = evaluateCase({
    id: 'case-1', category: 'aggregate', expected: { kind: 'rows', rows: [{ Total: 30 }] },
    expectedTables: ['KH_EvalContract'], expectedTools: ['render_chart']
  }, {
    executionResult: [{ Total: 30 }], contextSelection: { selectedTables: ['KH_EvalContract'] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true }, { toolName: 'render_chart', success: true }]
  });
  assert.equal(evaluation.passed, true);
});

test('evaluateCase accepts a clarification without SQL', () => {
  const evaluation = evaluateCase({ id: 'clarify', expected: { kind: 'clarification', replyPattern: 'bạn.*muốn' } }, {
    replyText: 'Bạn muốn xem khách hàng hay hợp đồng?', toolCalls: []
  });
  assert.equal(evaluation.passed, true);
});

test('validateCorpus rejects duplicate ids and summarize reports accuracy', () => {
  const validation = validateCorpus({ version: 1, cases: [
    { id: 'x', question: 'a', expected: { kind: 'empty' } },
    { id: 'x', question: 'b', expected: { kind: 'empty' } }
  ] });
  assert.equal(validation.valid, false);
  assert.equal(summarize([{ category: 'a', passed: true }, { category: 'a', passed: false }]).accuracy, 0.5);
});
