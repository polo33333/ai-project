'use strict';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
}

function getRequestPolicy(userMessage = '') {
  const query = normalize(userMessage);
  const chartRequired = /\b(bieu do|do thi|chart|visuali[sz]e|ve)\b/.test(query);
  const exportRequired = /\b(xuat|export|tai|download|gui)\b[^\n]{0,30}\b(file|tep|excel|xlsx|csv|pdf)\b|\b(file|tep|excel|xlsx|csv|pdf)\b[^\n]{0,30}\b(xuat|export|tai|download|gui)\b/.test(query);
  const dataRequired = chartRequired || exportRequired || /\b(ds|danh sach|liet ke|top|bao nhieu|thong ke|thong tin chi tiet|chi tiet|du lieu|data|doanh thu|san luong|nhan vien|nv|khach hang|hop dong)\b/.test(query);
  const monthMatch = query.match(/\b(\d+)\s*thang\b/);
  return {
    chartRequired,
    exportRequired,
    dataRequired,
    temporalMonths: monthMatch ? Number(monthMatch[1]) : null,
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
