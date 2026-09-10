'use strict';

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    const date = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/);
    if (date) return date[1];
    return trimmed;
  }
  return String(value);
}

function normalizeRow(row, columns = null) {
  const source = row && typeof row === 'object' ? row : {};
  const keys = columns || Object.keys(source).sort((a, b) => a.localeCompare(b));
  return Object.fromEntries(keys.map(key => [key, normalizeValue(source[key])]));
}

function valuesEqual(actual, expected, tolerance) {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= tolerance;
  return actual === expected;
}

function rowMatches(actual, expected, tolerance, strictColumns) {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (strictColumns && JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return false;
  return expectedKeys.every(key => Object.prototype.hasOwnProperty.call(actual, key)
    && valuesEqual(actual[key], expected[key], tolerance));
}

function compareRows(actualRows, expectedRows, options = {}) {
  const tolerance = Number(options.numericTolerance || 0);
  const ordered = options.ordered === true;
  const strictColumns = options.strictColumns === true;
  const expected = (expectedRows || []).map(row => normalizeRow(row));
  const actual = (actualRows || []).map(row => normalizeRow(row));
  if (actual.length !== expected.length) return { passed: false, reason: `row_count:${actual.length}!=${expected.length}`, actual, expected };
  if (ordered) {
    const mismatch = expected.findIndex((row, index) => !rowMatches(actual[index], row, tolerance, strictColumns));
    return mismatch < 0 ? { passed: true, reason: null, actual, expected }
      : { passed: false, reason: `row_mismatch:${mismatch}`, actual, expected };
  }
  const remaining = actual.slice();
  for (const expectedRow of expected) {
    const index = remaining.findIndex(actualRow => rowMatches(actualRow, expectedRow, tolerance, strictColumns));
    if (index < 0) return { passed: false, reason: 'missing_expected_row', actual, expected };
    remaining.splice(index, 1);
  }
  return { passed: true, reason: null, actual, expected };
}

function getFinalSqlRows(result) {
  if (Array.isArray(result?.executionResult)) return result.executionResult;
  const calls = (result?.toolCalls || []).filter(call => call.toolName === 'execute_sql_query' && call.success);
  return calls.length ? (calls[calls.length - 1].result?.rows || []) : null;
}

function evaluateCase(testCase, result) {
  const expected = testCase.expected || {};
  const kind = expected.kind || 'rows';
  let outcome;
  if (kind === 'rows' || kind === 'empty') {
    const rows = getFinalSqlRows(result);
    outcome = Array.isArray(rows) ? compareRows(rows, kind === 'empty' ? [] : expected.rows, expected) : { passed: false, reason: 'missing_sql_result' };
  } else if (['clarification', 'refusal', 'no_sql'].includes(kind)) {
    const hasSql = (result?.toolCalls || []).some(call => call.toolName === 'execute_sql_query' && call.success);
    const pattern = expected.replyPattern ? new RegExp(expected.replyPattern, 'iu') : null;
    const replyMatches = !pattern || pattern.test(String(result?.replyText || ''));
    outcome = { passed: !hasSql && replyMatches, reason: hasSql ? 'unexpected_sql' : (replyMatches ? null : 'reply_pattern') };
  } else outcome = { passed: false, reason: `unsupported_expected_kind:${kind}` };

  const selected = new Set(result?.contextSelection?.selectedTables || []);
  const missingTables = (testCase.expectedTables || []).filter(table => !selected.has(table));
  const artifactFailures = [];
  for (const tool of testCase.expectedTools || []) {
    if (!(result?.toolCalls || []).some(call => call.toolName === tool && call.success)) artifactFailures.push(tool);
  }
  const passed = outcome.passed && missingTables.length === 0 && artifactFailures.length === 0;
  return {
    id: testCase.id, category: testCase.category || 'uncategorized', passed, semanticPassed: outcome.passed,
    reason: outcome.reason || (missingTables.length ? `missing_tables:${missingTables.join(',')}` : null)
      || (artifactFailures.length ? `missing_tools:${artifactFailures.join(',')}` : null),
    missingTables, artifactFailures
  };
}

function validateCorpus(corpus) {
  const errors = [];
  if (!corpus || corpus.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(corpus?.cases) || corpus.cases.length === 0) errors.push('cases must be a non-empty array');
  const ids = new Set();
  for (const [index, item] of (corpus?.cases || []).entries()) {
    if (!item.id) errors.push(`cases[${index}].id is required`);
    else if (ids.has(item.id)) errors.push(`duplicate id: ${item.id}`);
    ids.add(item.id);
    if (!item.question) errors.push(`${item.id || index}: question is required`);
    if (!item.expected?.kind) errors.push(`${item.id || index}: expected.kind is required`);
    if (item.expected?.kind === 'rows' && !Array.isArray(item.expected.rows)) errors.push(`${item.id || index}: expected.rows is required`);
  }
  return { valid: errors.length === 0, errors };
}

function summarize(evaluations) {
  const total = evaluations.length;
  const passed = evaluations.filter(item => item.passed).length;
  const byCategory = {};
  for (const item of evaluations) {
    const bucket = byCategory[item.category] ||= { total: 0, passed: 0 };
    bucket.total += 1;
    if (item.passed) bucket.passed += 1;
  }
  return { total, passed, failed: total - passed, accuracy: total ? passed / total : 0, byCategory };
}

module.exports = { normalizeValue, compareRows, getFinalSqlRows, evaluateCase, validateCorpus, summarize };
