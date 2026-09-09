'use strict';

function hasIdentifier(sql, identifier) {
  const escaped = String(identifier || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !escaped || new RegExp(`\\b${escaped}\\b`, 'i').test(sql);
}

function evaluateSql(sql = '', plan = {}) {
  const text = String(sql || '');
  const violations = [];
  // Validate direct projections for simple single-table SELECTs. Complex SQL
  // (joins, CTEs, expressions) still needs database validation, not guessed rewrites.
  const code = text.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (plan.unfilteredList && /\bwhere\b/i.test(code)) violations.push('UNREQUESTED_FILTER');
  if (plan.schemaColumns?.length && !/\b(join|with|union|intersect|except)\b/i.test(code)
    && (code.match(/\bselect\b/gi) || []).length === 1) {
    const projection = code.match(/^\s*select\s+(?:distinct\s+)?(?:top\s*\(?\s*\d+\s*\)?\s+)?([\s\S]+?)\s+from\b/i)?.[1];
    const identifier = '(?:\\[[^\\]]+\\]|[a-z_][a-z0-9_]*)';
    const directColumn = new RegExp(`^\\s*(?:${identifier}\\s*\\.\\s*)?(${identifier})(?:\\s+(?:as\\s+)?${identifier})?\\s*$`, 'i');
    for (const expression of (projection || '').split(',')) {
      const match = expression.match(directColumn);
      if (!match) continue;
      const column = match[1].replace(/^\[|\]$/g, '');
      if (!plan.schemaColumns.some(name => name.toLowerCase() === column.toLowerCase())) violations.push(`UNKNOWN_COLUMN:${column}`);
    }
  }
  if (!/^(?:\s|;)*(?:select|with)\b/i.test(text)) violations.push('MISSING_SELECT');
  if (/\b(?:information_schema|sys\.(?:tables|columns|objects|schemas))\b/i.test(text)) violations.push('SCHEMA_QUERY');
  if (plan.table && !hasIdentifier(text, plan.table)) violations.push('WRONG_TABLE');
  for (const column of plan.requiredColumns || []) {
    if (!hasIdentifier(text, column)) violations.push(`MISSING_COLUMN:${column}`);
  }
  const aggregation = /^(?:SUM|AVG|MIN|MAX|COUNT)$/.test(String(plan.aggregation || '').toUpperCase())
    ? String(plan.aggregation).toLowerCase() : '(?:sum|avg|min|max|count)';
  if (plan.metric && plan.intent === 'aggregate_timeseries' && !new RegExp(`\\b${aggregation}\\s*\\(\\s*\\[?${String(plan.metric).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?`, 'i').test(text)) {
    violations.push(`WRONG_METRIC:${plan.metric}`);
  }
  if (plan.timeColumn && !hasIdentifier(text, plan.timeColumn)) violations.push(`WRONG_TIME_COLUMN:${plan.timeColumn}`);
  if (plan.temporalMonths && !/\bgroup\s+by\b/i.test(text)) violations.push('MISSING_TIME_BUCKET');
  return { valid: violations.length === 0, score: Math.max(0, 1 - violations.length * 0.2), violations };
}

module.exports = { evaluateSql };
