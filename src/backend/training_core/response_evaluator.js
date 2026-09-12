'use strict';

function evaluateResponse({ reply = '', plan = {}, toolCalls = [] } = {}) {
  const text = String(reply || '').trim();
  const success = name => toolCalls.some(call => (call.toolName || call.name) === name && call.success === true);
  const failures = [];
  if (!text) failures.push('EMPTY_ANSWER');
  if (plan.outputs?.data && text && text.replace(/\s+/g, '').length < 4) failures.push('INSUFFICIENT_DATA_ANSWER');
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/đ/g, 'd').replace(/[*_`#]/g, '');
  const reportsOnlyRowCount = /da truy van du lieu thanh cong[^\n]*tim thay[^\n]*dong ket qua/.test(normalized)
    || /^(?:tim thay|co)\s+\*{0,2}\d+\*{0,2}\s+(?:dong\s+)?ket qua[.!]?$/.test(normalized.trim());
  if (plan.outputs?.data && reportsOnlyRowCount) failures.push('INSUFFICIENT_DATA_ANSWER');
  if (/^\s*(?:```\s*)?(?:select|with)\b/i.test(text)) failures.push('SQL_ONLY_ANSWER');
  if (/schema|số cột|khóa chính/i.test(text) && plan.outputs?.data) failures.push('SCHEMA_ONLY_ANSWER');
  if (plan.outputs?.data && !success('execute_sql_query')) failures.push('MISSING_SQL');
  if (plan.outputs?.chart && !success('render_chart')) failures.push('MISSING_CHART');
  if (plan.outputs?.export && !success('export_data')) failures.push('MISSING_EXPORT');
  const uniqueFailures = [...new Set(failures)];
  return { valid: uniqueFailures.length === 0, score: Math.max(0, 1 - uniqueFailures.length * 0.2), failures: uniqueFailures };
}

module.exports = { evaluateResponse };
