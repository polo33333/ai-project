'use strict';

const DATA_INTENTS = new Set(['list', 'record_lookup', 'aggregate', 'aggregate_timeseries']);

function getRequestPolicy(plan = {}, context = {}) {
  const outputs = plan.outputs || {};
  const informational = plan.codeOnly === true || context.webSearch === true || context.knowledgeGrounding?.required === true
    || ['general', 'knowledge'].includes(context.mode);
  const chartRequired = !informational && outputs.chart === true;
  const exportRequired = !informational && outputs.export === true;
  const dataRequired = !informational && (outputs.data === true
    || (Boolean(plan.table) && DATA_INTENTS.has(plan.intent)) || chartRequired || exportRequired);
  return {
    chartRequired,
    exportRequired,
    dataRequired,
    temporalMonths: !informational && Number(plan.temporalMonths) > 0 ? Number(plan.temporalMonths) : null,
    maxSqlCalls: Math.max(1, Number(process.env.LOCAL_MODEL_MAX_SQL_CALLS || 3))
  };
}

function validateCallAgainstPolicy(call, args, policy, successfulCalls = []) {
  if (call.name !== 'execute_sql_query') return { valid: true };
  const sqlCalls = successfulCalls.filter(item => item.toolName === 'execute_sql_query').length;
  if (sqlCalls >= policy.maxSqlCalls) {
    return { valid: false, category: 'SQL_BUDGET_EXCEEDED', error: `SQL call budget (${policy.maxSqlCalls}) is exhausted. Use the existing SQL result and call render_chart now.` };
  }
  if (!policy.chartRequired || !policy.temporalMonths) return { valid: true };
  const sql = String(args.sql || '');
  const isProbe = /\bmax\s*\(/i.test(sql);
  const hasAggregation = /\bgroup\s+by\b/i.test(sql) && /\b(sum|avg|count|min|max)\s*\(/i.test(sql);
  const hasMonthBucket = /\bmonth\s*\(|datefromparts\s*\(|datetrunc\s*\(|eomonth\s*\(|datepart\s*\(\s*month|format\s*\([^,]+,\s*N?['"]yyyy[-/]MM['"]|convert\s*\(\s*(?:var)?char\s*\(\s*7\s*\)/i.test(sql);
  if (!isProbe && !(hasAggregation && hasMonthBucket)) {
    return {
      valid: false,
      category: 'TEMPORAL_SQL_POLICY',
      error: `The request asks for ${policy.temporalMonths} months. Do not use TOP ${policy.temporalMonths} raw rows. Aggregate by year/month with GROUP BY and SUM, select the latest ${policy.temporalMonths} monthly buckets, then call render_chart.`
    };
  }
  return { valid: true };
}

function hasSuccessfulTool(toolCalls, name) {
  return toolCalls.some(call => call.toolName === name && call.success);
}

function sanitizeFinalText(text, hasChart) {
  let clean = String(text || '');
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  clean = clean.replace(/https?:\/\/(?:www\.)?example\.com\/\S*/gi, '');
  if (!hasChart) {
    clean = clean.replace(/(?:biểu đồ|chart)[^\n]*(?:đã được tạo|được hiển thị|thực tế sẽ được hiển thị)[^\n]*/gi, '');
  }
  return clean.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { getRequestPolicy, validateCallAgainstPolicy, hasSuccessfulTool, sanitizeFinalText };
