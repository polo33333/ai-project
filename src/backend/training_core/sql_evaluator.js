'use strict';

function hasIdentifier(sql, identifier) {
  const escaped = String(identifier || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !escaped || new RegExp(`\\b${escaped}\\b`, 'i').test(sql);
}

function evaluateSql(sql = '', plan = {}) {
  const text = String(sql || '');
  const violations = [];
  if (!/^(?:\s|;)*(?:select|with)\b/i.test(text)) violations.push('MISSING_SELECT');
  if (/\b(?:information_schema|sys\.(?:tables|columns|objects|schemas))\b/i.test(text)) violations.push('SCHEMA_QUERY');
  if (plan.table && !hasIdentifier(text, plan.table)) violations.push('WRONG_TABLE');
  for (const column of plan.requiredColumns || []) {
    if (!hasIdentifier(text, column)) violations.push(`MISSING_COLUMN:${column}`);
  }
  if (plan.metric && plan.intent === 'aggregate_timeseries' && !new RegExp(`\\b(?:sum|avg|min|max|count)\\s*\\(\\s*\\[?${String(plan.metric).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?`, 'i').test(text)) {
    violations.push(`WRONG_METRIC:${plan.metric}`);
  }
  if (plan.timeColumn && !hasIdentifier(text, plan.timeColumn)) violations.push(`WRONG_TIME_COLUMN:${plan.timeColumn}`);
  if (plan.temporalMonths && !/\bgroup\s+by\b/i.test(text)) violations.push('MISSING_TIME_BUCKET');
  return { valid: violations.length === 0, score: Math.max(0, 1 - violations.length * 0.2), violations };
}

module.exports = { evaluateSql };
