'use strict';

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
}

function mentionsIdentifier(text, identifier) {
  const escaped = String(identifier || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped) && new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(String(text || ''));
}

function createRequestPlan({ question = '', selectedTables = [], dictionaryTables = [], domainAliases } = {}) {
  const normalized = normalize(question);
  const selectedNames = selectedTables.map(item => String(item?.tableName || item));
  const explicitTables = dictionaryTables.filter(table => mentionsIdentifier(question, table.tableName));
  const rankedTables = explicitTables.length
    ? explicitTables
    : selectedNames.map(name => dictionaryTables.find(table => table.tableName.toLowerCase() === name.toLowerCase())).filter(Boolean);
  const aliases = domainAliases ?? require('../intelligent_core/domain_alias_service').getDomainAliases();
  const phrase = value => normalize(value).replace(/[^a-z0-9]+/g, ' ').trim();
  const questionWords = ` ${phrase(question)} `;
  const domainMatches = table => {
    const domain = phrase(table.domain);
    if (!domain) return false;
    const terms = [domain, ...Object.entries(aliases)
      .filter(([key]) => phrase(key) === domain)
      .flatMap(([, values]) => Array.isArray(values) ? values : [])];
    return terms.some(term => phrase(term) && questionWords.includes(` ${phrase(term)} `));
  };
  // Explicit table names win; otherwise prefer configured domains within the
  // retrieved candidates. Preserve retrieval order for ties and unknown domains.
  const table = (!explicitTables.length && rankedTables.find(domainMatches)) || rankedTables[0] || null;
  const mentionedColumns = dictionaryTables.flatMap(candidate => candidate.columns
    .filter(column => mentionsIdentifier(question, column.columnName))
    .map(column => ({ ...column, tableName: candidate.tableName })));
  const tableColumns = table ? mentionedColumns.filter(column => column.tableName === table.tableName) : mentionedColumns;
  const numericType = /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i;
  const availableColumns = table?.columns || [];
  const numericColumns = availableColumns.filter(column => numericType.test(column.dataType) && !/id$/i.test(column.columnName));
  const tableBase = String(table?.tableName || '').replace(/^[A-Z]+_/i, '');
  const configuredMetric = availableColumns.find(column => column.columnName === table?.defaultMetric && numericType.test(column.dataType));
  const metric = tableColumns.find(column => numericType.test(column.dataType) && !/id$/i.test(column.columnName))
    || configuredMetric
    || (/(?:san luong|so luong|quantity|output)/.test(normalized)
      ? numericColumns.find(column => /^(?:total)?qty$|quantity|output/i.test(column.columnName) && !/money|amount/i.test(column.columnName))
      : null)
    || (/(?:doanh thu|thanh tien|revenue|amount)/.test(normalized)
      ? numericColumns.find(column => /final.*(?:money|amount)|revenue|total.*(?:money|amount)/i.test(column.columnName))
      : null)
    || null;
  const dateColumns = availableColumns.filter(column => /date|time/i.test(column.dataType));
  const months = Number(normalized.match(/\b(\d+)\s*thang\b/)?.[1]) || null;
  const configuredTimeColumn = dateColumns.find(column => column.columnName === table?.defaultTimeColumn);
  const timeColumn = tableColumns.find(column => /date|time/i.test(column.dataType))
    || (months ? configuredTimeColumn : null)
    || (months ? dateColumns.find(column => column.columnName.toLowerCase() === `${tableBase}Date`.toLowerCase()) : null)
    || (months ? dateColumns.find(column => !/create|update|payment/i.test(column.columnName)) : null)
    || (months ? dateColumns[0] : null)
    || null;
  // Available data is a different time scope from calendar-relative months.
  const calendarRelative = /\b(?:hom nay|thang nay|tinh den hien tai|tinh den hom nay|calendar)\b/.test(normalized);
  const allowLatestAvailableMonths = months !== null && !calendarRelative
    && /\b(?:gan nhat|co du lieu|du lieu san co|latest available)\b/.test(normalized);
  return {
    version: 1,
    intent: months ? 'aggregate_timeseries' : /\b(ds|danh sach|liet ke|top)\b/.test(normalized) ? 'list' : 'record_lookup',
    question,
    table: table?.tableName || null,
    schemaColumns: (table?.columns || []).map(column => column.columnName),
    unfilteredList: Boolean(table && [table.tableName, table.domain, ...(aliases[table.domain] || [])].filter(Boolean)
      .some(term => ['ds', 'danh sach', 'liet ke'].some(prefix => phrase(question) === `${prefix} ${phrase(term)}`))),
    requiredColumns: [...new Set(tableColumns.map(column => column.columnName))],
    metric: metric?.columnName || null,
    aggregation: metric ? (table?.defaultAggregation || 'SUM').toUpperCase() : null,
    timeColumn: timeColumn?.columnName || null,
    temporalMonths: months,
    allowLatestAvailableMonths,
    outputs: {
      data: /\b(ds|danh sach|liet ke|top|chi tiet|du lieu|doanh thu|san luong|nhan vien|nv|khach hang|hop dong)\b/.test(normalized) || months !== null,
      chart: /\b(bieu do|do thi|chart|visuali[sz]e|ve)\b/.test(normalized),
      export: /\b(xuat|export|tai|download|gui)\b[^\n]{0,30}\b(file|tep|excel|xlsx|csv|pdf)\b|\b(file|tep|excel|xlsx|csv|pdf)\b[^\n]{0,30}\b(xuat|export|tai|download|gui)\b/.test(normalized)
    }
  };
}

module.exports = { createRequestPlan, normalize, mentionsIdentifier };
