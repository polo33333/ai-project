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
  if (plan.metric && (['aggregate', 'aggregate_timeseries'].includes(plan.intent) || plan.conversationState?.operation === 'aggregate') && !matchesAggregate(text, plan.metric, plan.aggregation)) {
    violations.push(`WRONG_METRIC:${plan.metric}`);
  }
  for (const measure of plan.requiredMeasures || []) {
    if (!matchesAggregate(text, `${measure.table}.${measure.column}`, measure.aggregation)) violations.push(`WRONG_METRIC:${measure.column}`);
  }
  if (plan.timeColumn && !hasIdentifier(text, plan.timeColumn)) violations.push(`WRONG_TIME_COLUMN:${plan.timeColumn}`);
  if (plan.temporalMonths && !/\bgroup\s+by\b/i.test(text)) violations.push('MISSING_TIME_BUCKET');
  return { valid: violations.length === 0, score: Math.max(0, 1 - violations.length * 0.2), violations };
}

module.exports = { evaluateSql };

// Only a projected aggregate of the requested physical column is evidence.
// Mentions in comments, predicates or another aggregate's alias are insufficient.
// The whole projected expression must be that aggregate (CAST/ROUND/ISNULL
// wrappers keep its value); SUM(x) * 0 or SUM(x) / 2 is a different measure.
function matchesAggregate(sql, metric, aggregation) {
  try {
    const { unwrapValuePreserving, sourceForColumn } = require('../services/sql_expression');
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    const statement = Array.isArray(parsed) ? parsed[0] : parsed;
    const parts = String(metric).replace(/[\[\]]/g, '').toLowerCase().split('.');
    const name = parts.pop();
    const qualifier = parts.pop();
    const matches = node => {
      if (node?.type !== 'aggr_func') return false;
      const expr = node.args?.expr;
      if (aggregation && String(node.name).toUpperCase() !== String(aggregation).toUpperCase()) return false;
      if (expr?.type !== 'column_ref' || String(expr.column).toLowerCase() !== name) return false;
      if (!qualifier) return true;
      const source = sourceForColumn(expr, statement.from || []);
      return String(source ? source.table : expr.table).toLowerCase() === qualifier;
    };
    return (statement.columns || []).some(column => matches(unwrapValuePreserving(column.expr)));
  } catch { return false; }
}
