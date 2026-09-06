'use strict';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
}

function mentionsIdentifier(text, identifier) {
  const escaped = String(identifier || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped) && new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(String(text || ''));
}

function createRequestPlan({ question = '', selectedTables = [], dictionaryTables = [] } = {}) {
  const normalized = normalize(question);
  const selectedNames = selectedTables.map(item => String(item?.tableName || item));
  const explicitTables = dictionaryTables.filter(table => mentionsIdentifier(question, table.tableName));
  const rankedTables = explicitTables.length
    ? explicitTables
    : selectedNames.map(name => dictionaryTables.find(table => table.tableName.toLowerCase() === name.toLowerCase())).filter(Boolean);
  const table = rankedTables[0] || null;
  const mentionedColumns = dictionaryTables.flatMap(candidate => candidate.columns
    .filter(column => mentionsIdentifier(question, column.columnName))
    .map(column => ({ ...column, tableName: candidate.tableName })));
  const tableColumns = table ? mentionedColumns.filter(column => column.tableName === table.tableName) : mentionedColumns;
  const numericType = /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i;
  const metric = tableColumns.find(column => numericType.test(column.dataType) && !/id$/i.test(column.columnName)) || null;
  const timeColumn = tableColumns.find(column => /date|time/i.test(column.dataType)) || null;
  const months = Number(normalized.match(/\b(\d+)\s*thang\b/)?.[1]) || null;
  return {
    version: 1,
    intent: months ? 'aggregate_timeseries' : /\b(ds|danh sach|liet ke|top)\b/.test(normalized) ? 'list' : 'record_lookup',
    question,
    table: table?.tableName || null,
    requiredColumns: [...new Set(tableColumns.map(column => column.columnName))],
    metric: metric?.columnName || null,
    timeColumn: timeColumn?.columnName || null,
    temporalMonths: months,
    outputs: {
      data: /\b(ds|danh sach|liet ke|top|chi tiet|du lieu|doanh thu|san luong|nhan vien|nv|khach hang|hop dong)\b/.test(normalized) || months !== null,
      chart: /\b(bieu do|do thi|chart|visuali[sz]e|ve)\b/.test(normalized),
      export: /\b(xuat|export|tai|download|gui)\b[^\n]{0,30}\b(file|tep|excel|xlsx|csv|pdf)\b|\b(file|tep|excel|xlsx|csv|pdf)\b[^\n]{0,30}\b(xuat|export|tai|download|gui)\b/.test(normalized)
    }
  };
}

module.exports = { createRequestPlan, normalize, mentionsIdentifier };
