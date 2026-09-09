/** Dynamic schema retrieval: Qdrant + lexical matching + glossary expansion. */

const dictionaryService = require('../services/dictionary_service');
const qdrantService = require('../services/qdrant_service');
const domainAliasService = require('./domain_alias_service');

const MAX_TABLES = Math.max(1, parseInt(process.env.AI_SCHEMA_MAX_TABLES || '6', 10));
const MAX_COLUMNS_PER_TABLE = Math.max(5, parseInt(process.env.AI_SCHEMA_MAX_COLUMNS_PER_TABLE || '40', 10));
const MAX_CONTEXT_CHARS = Math.max(2000, parseInt(process.env.AI_SCHEMA_MAX_CONTEXT_CHARS || '18000', 10));
const STOP_WORDS = new Set(['ai', 'ban', 'toi', 'la', 'cho', 'cua', 'va', 'voi', 'nay', 'kia', 'gi', 'co', 'khong', 'hay', 'theo', 'trong', 'duoc']);

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\W]+/g, ' ')
    .toLowerCase().trim();
}

function tokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter(token => token.length >= 2 && !STOP_WORDS.has(token)))];
}

function lexicalScore(queryTokens, text) {
  const haystack = ` ${normalize(text)} `;
  return queryTokens.reduce((score, token) => score + (haystack.includes(` ${token} `) ? 4 : (token.length >= 4 && haystack.includes(token)) ? 1 : 0), 0);
}

function domainText(domain) {
  const normalizedDomain = normalize(domain);
  if (!normalizedDomain) return '';
  const paddedDomain = ` ${normalizedDomain} `;
  const aliases = Object.entries(domainAliasService.getDomainAliases())
    .filter(([canonical, terms]) => normalize(canonical) === normalizedDomain || terms.some(term => paddedDomain.includes(` ${normalize(term)} `)))
    .flatMap(([canonical, terms]) => [canonical, ...terms]);
  return [domain, ...aliases].join(' ');
}

function tableText(table) {
  return [table.tableName, table.dbName, table.domain, domainText(table.domain), table.tableDescription,
    table.defaultMetric, table.defaultTimeColumn, table.defaultAggregation,
    ...(table.columns || []).flatMap(column => [column.columnName, column.description, column.dataType])
  ].filter(Boolean).join(' ');
}

function isStandaloneCalculation(query, options = {}) {
  const normalized = normalize(query);
  const numberCount = (String(query || '').match(/-?\d+(?:[.,]\d+)?/g) || []).length;
  const hasStatisticOperation = /\b(min|max|avg|average|trung binh|tong|sum|dem|count|median|trung vi)\b/.test(normalized);
  const hasArithmeticExpression = /\d\s*(?:\+|-|\*|\/|%|\^)\s*\d/.test(String(query || ''));
  const hasDatabaseIntent = /\b(sql|database|db|du lieu|bang|cot|truy van|bao cao|bieu do|do thi|xuat file|excel|csv|pdf)\b/.test(normalized);
  return numberCount >= 2
    && (hasStatisticOperation || hasArithmeticExpression)
    && !hasDatabaseIntent
    && options.hasSchemaMatch !== true;
}

function isGeneralConversation(query, queryTokens, tables, hasGlossaryExpansion = false) {
  const normalized = normalize(query);
  const hasSchemaMatch = tables.some(table => lexicalScore(queryTokens, tableText(table)) > 0);
  const dataIntent = /\b(sql|database|db|du lieu|bang|cot|truy van|bao cao|thong ke|bieu do|do thi|xuat file|excel|csv|pdf|ds|danh sach|chi tiet|hop dong)\b/.test(normalized);
  const greeting = /^(hi|hello|hey|chao|xin chao|cam on|thank you|thanks)(\s+ban)?[.!?\s]*$/.test(normalized);
  const standaloneCalculation = isStandaloneCalculation(query, { hasSchemaMatch });
  return greeting || standaloneCalculation || (!hasGlossaryExpansion && !dataIntent && !hasSchemaMatch && queryTokens.length <= 4);
}

function expandWithGlossary(query) {
  const normalizedQuery = ` ${normalize(query)} `;
  const expansions = dictionaryService.getGlossary()
    .filter(item => normalizedQuery.includes(` ${normalize(item.term)} `))
    .flatMap(item => [item.term, item.fullMeaning]);
  return [query, ...expansions].filter(Boolean).join(' ');
}

function selectColumns(table, expandedQuery, vectorColumnNames = new Set()) {
  const queryTokens = tokens(expandedQuery);
  const ranked = (table.columns || []).map((column, index) => ({
    column,
    index,
    score: lexicalScore(queryTokens, `${column.columnName} ${column.description || ''}`) +
      (column.isPrimaryKey ? 5 : 0) + (vectorColumnNames.has(`${table.tableName}.${column.columnName}`) ? 8 : 0)
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, MAX_COLUMNS_PER_TABLE).map(item => item.column);
}

async function buildSchemaContext(query, options = {}) {
  const dbName = options.dbName || null;
  const activeTables = dictionaryService.getGroupedTables().filter(table => table.isActive && (!dbName || table.dbName === dbName));
  const expandedQuery = expandWithGlossary(query);
  const queryTokens = tokens(expandedQuery);
  if (isGeneralConversation(query, queryTokens, activeTables, normalize(expandedQuery) !== normalize(query))) {
    return { mode: 'general', schemaContext: '', selectedTables: [], useTools: false };
  }

  const expandedTokens = tokens(expandedQuery);
  const lexicalScores = new Map(activeTables.map(table => [table.tableName, lexicalScore(expandedTokens, tableText(table))]));
  const scores = new Map(lexicalScores);
  const vectorColumnNames = new Set();
  let vectorResults = [];
  try { vectorResults = await qdrantService.searchSchema(expandedQuery, Math.max(12, MAX_TABLES * 3)); } catch (_) {}

  vectorResults.forEach((result, index) => {
    const payload = result.payload || {};
    const rankBoost = Math.max(0.1, (vectorResults.length - index) / Math.max(1, vectorResults.length));
    const names = [payload.tableName, payload.sourceTable, payload.targetTable].filter(Boolean);
    names.forEach(name => {
      if (scores.has(name)) scores.set(name, (scores.get(name) || 0) + rankBoost + Math.max(0, Number(result.score) || 0));
    });
    if (payload.type === 'column' && payload.tableName && payload.columnName) {
      vectorColumnNames.add(`${payload.tableName}.${payload.columnName}`);
    }
  });

  const rankedTables = activeTables
    .map((table, index) => ({ table, index, score: scores.get(table.tableName) || 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const maxLexicalScore = Math.max(0, ...lexicalScores.values());
  const tablePool = maxLexicalScore >= 4
    ? rankedTables.filter(item => (lexicalScores.get(item.table.tableName) || 0) > 0)
    : rankedTables;
  const selected = tablePool.slice(0, Math.min(MAX_TABLES, tablePool.length)).map(item => item.table);
  const selectedNames = new Set(selected.map(table => table.tableName));

  const relationships = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false)
    .filter(relation => selectedNames.has(relation.sourceTable) || selectedNames.has(relation.targetTable));
  for (const relation of relationships) {
    for (const relatedName of [relation.sourceTable, relation.targetTable]) {
      if (!selectedNames.has(relatedName) && selected.length < MAX_TABLES) {
        const related = activeTables.find(table => table.tableName === relatedName);
        if (related) { selected.push(related); selectedNames.add(relatedName); }
      }
    }
  }

  const lines = [];
  for (const table of selected) {
    const columns = selectColumns(table, expandedQuery, vectorColumnNames);
    const defaults = table.defaultMetric || table.defaultTimeColumn
      ? ` [Defaults: metric=${table.defaultMetric || 'none'}, time=${table.defaultTimeColumn || 'none'}, aggregation=${table.defaultAggregation || 'SUM'}]` : '';
    lines.push(`Table ${table.tableName}${table.domain ? ` [Business domain: ${table.domain}]` : ''}${defaults}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`);
    lines.push(`Columns: ${columns.map(column => `${column.columnName} ${column.dataType}${column.isPrimaryKey ? ' PK' : ''}${column.description ? ` (${column.description})` : ''}`).join('; ')}`);
  }
  if (relationships.length > 0) {
    lines.push('Relationships:');
    relationships.forEach(relation => lines.push(`- ${relation.sourceTable}.${relation.sourceColumn} -> ${relation.targetTable}.${relation.targetColumn} (${relation.relationType || 'related'})`));
  }

  return {
    mode: 'data',
    schemaContext: lines.join('\n').slice(0, MAX_CONTEXT_CHARS),
    selectedTables: selected.map(table => table.tableName),
    useTools: true,
    retrieval: { vectorMatches: vectorResults.length, activeTableCount: activeTables.length },
    needsModelSelection: maxLexicalScore < 4,
    tableCatalog: activeTables.map(table => `${table.tableName}${table.domain ? ` [domain: ${table.domain}]` : ''}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`).join('\n').slice(0, 12000)
  };
}

function refineSchemaContext(query, requestedTableNames = [], options = {}) {
  const dbName = options.dbName || null;
  const activeTables = dictionaryService.getGroupedTables().filter(table => table.isActive && (!dbName || table.dbName === dbName));
  const requested = new Set(requestedTableNames.map(name => String(name).toLowerCase()));
  const selected = activeTables.filter(table => requested.has(table.tableName.toLowerCase())).slice(0, MAX_TABLES);
  if (selected.length === 0) return null;
  const selectedNames = new Set(selected.map(table => table.tableName));
  const relationships = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false)
    .filter(relation => selectedNames.has(relation.sourceTable) || selectedNames.has(relation.targetTable));
  for (const relation of relationships) {
    for (const name of [relation.sourceTable, relation.targetTable]) {
      if (!selectedNames.has(name) && selected.length < MAX_TABLES) {
        const table = activeTables.find(item => item.tableName === name);
        if (table) { selected.push(table); selectedNames.add(name); }
      }
    }
  }
  const lines = [];
  for (const table of selected) {
    const columns = selectColumns(table, query, new Set());
    const defaults = table.defaultMetric || table.defaultTimeColumn
      ? ` [Defaults: metric=${table.defaultMetric || 'none'}, time=${table.defaultTimeColumn || 'none'}, aggregation=${table.defaultAggregation || 'SUM'}]` : '';
    lines.push(`Table ${table.tableName}${table.domain ? ` [Business domain: ${table.domain}]` : ''}${defaults}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`);
    lines.push(`Columns: ${columns.map(column => `${column.columnName} ${column.dataType}${column.isPrimaryKey ? ' PK' : ''}${column.description ? ` (${column.description})` : ''}`).join('; ')}`);
  }
  if (relationships.length) {
    lines.push('Relationships:');
    relationships.forEach(relation => lines.push(`- ${relation.sourceTable}.${relation.sourceColumn} -> ${relation.targetTable}.${relation.targetColumn} (${relation.relationType || 'related'})`));
  }
  return {
    mode: 'data', useTools: true,
    schemaContext: lines.join('\n').slice(0, MAX_CONTEXT_CHARS),
    selectedTables: selected.map(table => table.tableName),
    retrieval: { strategy: 'model_table_selector', activeTableCount: activeTables.length }
  };
}

module.exports = { buildSchemaContext, refineSchemaContext, isStandaloneCalculation };
