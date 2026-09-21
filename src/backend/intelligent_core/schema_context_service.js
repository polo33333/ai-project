/** Dynamic schema retrieval: Qdrant + lexical matching + glossary expansion. */

const dictionaryService = require('../services/dictionary_service');
const qdrantService = require('../services/qdrant_service');
const domainAliasService = require('./domain_alias_service');
const { tableIdentity } = require('../services/schema_identity');
const joinPlannerService = require('../services/join_planner_service');

const MAX_TABLES = Math.max(1, parseInt(process.env.AI_SCHEMA_MAX_TABLES || '6', 10));
const MAX_COLUMNS_PER_TABLE = Math.max(5, parseInt(process.env.AI_SCHEMA_MAX_COLUMNS_PER_TABLE || '40', 10));
const MAX_CONTEXT_CHARS = Math.max(2000, parseInt(process.env.AI_SCHEMA_MAX_CONTEXT_CHARS || '18000', 10));
const JOIN_MAX_EDGES = Math.max(1, Math.min(20, parseInt(process.env.SQL_JOIN_MAX_EDGES || '3', 10) || 3));
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

function relationshipRelevant(queryTokens, relation, tables = []) {
  const source = tables.find(table => tableIdentity(table) === relation.sourceTableId);
  const target = tables.find(table => tableIdentity(table) === relation.targetTableId);
  const pairs = relation.columnPairs?.length ? relation.columnPairs : [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }];
  const columnSignals = pairs.flatMap(pair => {
    const sourceColumn = source?.columns?.find(column => column.columnName === pair.sourceColumn);
    const targetColumn = target?.columns?.find(column => column.columnName === pair.targetColumn);
    return [pair.sourceColumn, sourceColumn?.description, pair.targetColumn, targetColumn?.description];
  });
  // In roles such as "Giới tính của nhân viên", the text before "của" is the
  // relationship subject; the suffix merely names the source entity.
  const roleSubject = normalize(relation.businessRole).split(/\s+cua\s+/)[0];
  const signalTokens = new Set(tokens([roleSubject, relation.description, ...columnSignals].filter(Boolean).join(' ')));
  return queryTokens.some(token => signalTokens.has(token));
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
    ...(table.columns || []).filter(column => column.isVisible !== false).flatMap(column => [column.columnName, column.description, column.dataType])
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
  const ranked = (table.columns || []).filter(column => column.isVisible !== false).map((column, index) => ({
    column,
    index,
    score: lexicalScore(queryTokens, `${column.columnName} ${column.description || ''}`) +
      (column.isPrimaryKey ? 5 : 0) + (vectorColumnNames.has(`${table.tableName}.${column.columnName}`) ? 8 : 0)
  })).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.slice(0, MAX_COLUMNS_PER_TABLE).map(item => item.column);
}

function automaticEnrichmentRelations(rootTable, activeTables) {
  if (!rootTable || process.env.SQL_JOIN_PLANNER_ENABLED !== 'true') return [];
  const limit = Math.max(0, Number(process.env.SQL_AUTO_ENRICH_MAX_RELATIONSHIPS || 6));
  return dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified')
    .filter(relation => relation.sourceTableId === tableIdentity(rootTable))
    .filter(relation => ['many-to-one', 'one-to-one'].includes(relation.cardinality || relation.relationType))
    .filter(relation => activeTables.some(table => tableIdentity(table) === relation.targetTableId))
    .filter(relation => (relation.columnPairs || []).length > 0 && relation.columnPairs.every(pair => {
      const column = (rootTable.columns || []).find(item => item.columnName === pair.sourceColumn);
      return Boolean(column?.description?.trim());
    }))
    .slice(0, limit);
}

async function buildSchemaContext(query, options = {}) {
  const dbName = options.dbName || null;
  const dbSourceId = options.dbSourceId || null;
  const activeTables = dictionaryService.getGroupedTables().filter(table => table.isActive
    && (!dbName || table.dbName === dbName)
    && (!dbSourceId || !table.dbSourceId || table.dbSourceId === dbSourceId));
  const expandedQuery = expandWithGlossary(query);
  const queryTokens = tokens(expandedQuery);
  if (isGeneralConversation(query, queryTokens, activeTables, normalize(expandedQuery) !== normalize(query))) {
    return { mode: 'general', schemaContext: '', selectedTables: [], useTools: false };
  }

  const expandedTokens = tokens(expandedQuery);
  const lexicalScores = new Map(activeTables.map(table => [tableIdentity(table), lexicalScore(expandedTokens, tableText(table))]));
  const scores = new Map(lexicalScores);
  const vectorColumnNames = new Set();
  let vectorResults = [];
  try { vectorResults = await qdrantService.searchSchema(expandedQuery, Math.max(12, MAX_TABLES * 3)); } catch (_) {}

  vectorResults.forEach((result, index) => {
    const payload = result.payload || {};
    const rankBoost = Math.max(0.1, (vectorResults.length - index) / Math.max(1, vectorResults.length));
    const candidates = payload.tableId
      ? activeTables.filter(table => tableIdentity(table) === payload.tableId)
      : activeTables.filter(table => [payload.tableName, payload.sourceTable, payload.targetTable].includes(table.tableName));
    candidates.forEach(table => {
      const key = tableIdentity(table);
      scores.set(key, (scores.get(key) || 0) + rankBoost + Math.max(0, Number(result.score) || 0));
    });
    if (payload.type === 'column' && payload.tableName && payload.columnName && candidates.length > 0) {
      vectorColumnNames.add(`${payload.tableName}.${payload.columnName}`);
    }
  });

  const rankedTables = activeTables
    .map((table, index) => ({ table, index, score: scores.get(tableIdentity(table)) || 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const maxLexicalScore = Math.max(0, ...lexicalScores.values());
  const strongLexicalThreshold = Math.max(4, Math.ceil(maxLexicalScore * 0.5));
  const tablePool = maxLexicalScore >= 4
    ? rankedTables.filter(item => (lexicalScores.get(tableIdentity(item.table)) || 0) >= strongLexicalThreshold)
    : rankedTables;
  const selected = tablePool.slice(0, Math.min(MAX_TABLES, tablePool.length)).map(item => item.table);
  const selectedNames = new Set(selected.map(table => table.tableName));
  const requestedIds = selected.slice(0, MAX_TABLES).map(table => tableIdentity(table));
  const parallelRelationshipIds = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified'
      && relationshipRelevant(expandedTokens, relation, activeTables)).map(relation => relation.id);
  const enrichmentRelations = selected.length === 1 ? automaticEnrichmentRelations(selected[0], activeTables) : [];
  let joinPlan = enrichmentRelations.length
    ? joinPlannerService.planEnrichment(tableIdentity(selected[0]), enrichmentRelations, { dbSourceId })
    : process.env.SQL_JOIN_PLANNER_ENABLED === 'true' && requestedIds.length > 1
      ? joinPlannerService.planJoin(requestedIds, { dbSourceId, maxEdges: JOIN_MAX_EDGES, parallelRelationshipIds,
        rootTableId: requestedIds[0], expectedGrain: 'root' }) : null;
  if (joinPlan?.outcome === 'ready') {
    for (const ref of joinPlan.tableRefs) {
      if (selected.some(table => tableIdentity(table) === ref.tableId) || selected.length >= MAX_TABLES) continue;
      const bridge = activeTables.find(table => tableIdentity(table) === ref.tableId);
      if (bridge) { selected.push(bridge); selectedNames.add(bridge.tableName); }
    }
  }

  let relationships = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified')
    .filter(relation => selected.some(table => tableIdentity(table) === relation.sourceTableId)
      || selected.some(table => tableIdentity(table) === relation.targetTableId));
  if (joinPlan?.outcome === 'ready' && joinPlan.edges.length) {
    const plannedIds = new Set(joinPlan.edges.map(edge => edge.relationshipId));
    relationships = relationships.filter(relation => plannedIds.has(relation.id));
  } else {
    relationships = relationships.filter(relation => relationshipRelevant(expandedTokens, relation, activeTables));
  }
  for (const relation of relationships) {
    for (const relatedId of [relation.sourceTableId, relation.targetTableId]) {
      if (!selected.some(table => tableIdentity(table) === relatedId) && selected.length < MAX_TABLES) {
        const related = activeTables.find(table => tableIdentity(table) === relatedId);
        if (related) { selected.push(related); selectedNames.add(related.tableName); }
      }
    }
  }
  if (process.env.SQL_JOIN_PLANNER_ENABLED === 'true' && selected.length > 1
      && (!joinPlan || joinPlan.outcome !== 'ready' || !joinPlan.edges.length)) {
    const selectedIds = selected.slice(0, MAX_TABLES).map(table => tableIdentity(table));
    joinPlan = joinPlannerService.planJoin(selectedIds, {
      dbSourceId, maxEdges: JOIN_MAX_EDGES, parallelRelationshipIds: relationships.map(relation => relation.id),
      rootTableId: selectedIds[0], expectedGrain: 'root'
    });
    if (joinPlan.outcome === 'ready') {
      const plannedIds = new Set(joinPlan.edges.map(edge => edge.relationshipId));
      relationships = relationships.filter(relation => plannedIds.has(relation.id));
    }
  }

  const lines = [];
  const requiredColumns = new Map();
  const relationshipMappedColumns = new Set();
  relationships.forEach(relation => (relation.columnPairs || []).forEach(pair => {
    if (relation.businessRole && relation.displayColumn) relationshipMappedColumns.add(`${relation.sourceTableId}\u0000${pair.sourceColumn}`);
    requiredColumns.set(relation.sourceTableId, new Set([...(requiredColumns.get(relation.sourceTableId) || []), pair.sourceColumn]));
    requiredColumns.set(relation.targetTableId, new Set([...(requiredColumns.get(relation.targetTableId) || []), pair.targetColumn]));
    if (relation.displayColumn) requiredColumns.set(relation.targetTableId, new Set([...(requiredColumns.get(relation.targetTableId) || []), relation.displayColumn]));
  }));
  for (const table of selected) {
    const rankedColumns = selectColumns(table, expandedQuery, vectorColumnNames);
    const mandatory = requiredColumns.get(tableIdentity(table)) || new Set();
    const columns = [...rankedColumns, ...(table.columns || []).filter(column => column.isVisible !== false && mandatory.has(column.columnName) && !rankedColumns.some(item => item.columnName === column.columnName))];
    const defaults = table.defaultMetric || table.defaultTimeColumn
      ? ` [Defaults: metric=${table.defaultMetric || 'none'}, time=${table.defaultTimeColumn || 'none'}, aggregation=${table.defaultAggregation || 'SUM'}]` : '';
    lines.push(`Table ${table.tableName}${table.domain ? ` [Business domain: ${table.domain}]` : ''}${defaults}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`);
    lines.push(`Columns: ${columns.map(column => `${column.columnName} ${column.dataType}${column.isPrimaryKey ? ' PK' : ''}${column.displayName && !relationshipMappedColumns.has(`${tableIdentity(table)}\u0000${column.columnName}`) ? ` [result header: ${column.displayName}]` : ''}${column.description ? ` (${column.description})` : ''}`).join('; ')}`);
  }
  if (relationships.length > 0) {
    lines.push('Relationships:');
    relationships.forEach(relation => lines.push(`- ${(relation.columnPairs || []).map(pair => `${relation.sourceTable}.${pair.sourceColumn} -> ${relation.targetTable}.${pair.targetColumn}`).join(' AND ')} (${relation.cardinality || relation.relationType || 'related'}; role=${relation.businessRole || 'unspecified'}; display=${relation.displayColumn || 'unspecified'})`));
    if (joinPlan?.purpose === 'enrichment') lines.push('Auto-enrichment requirement: when returning rows from the primary table, JOIN every relationship listed above and include the mapped display column instead of its foreign-key ID. Alias each mapped display value with the exact relationship role as the result header. Order result columns as identity Code/Name fields, mapped display values, other business fields, then unmapped ID fields. Use each planned alias separately when several fields point to the same lookup table.');
  }

  if (joinPlan) {
    joinPlan.allowedTableIds = selected.map(table => tableIdentity(table));
    joinPlan.allowedTableNames = selected.map(table => table.tableName);
    joinPlan.dbSourceId ||= dbSourceId;
  }
  return {
    mode: 'data',
    schemaContext: lines.join('\n').slice(0, MAX_CONTEXT_CHARS),
    selectedTables: selected.map(table => table.tableName),
    selectedTableIds: selected.map(table => tableIdentity(table)),
    useTools: true,
    joinPlan,
    retrieval: { vectorMatches: vectorResults.length, activeTableCount: activeTables.length },
    needsModelSelection: maxLexicalScore < 4,
    tableCatalog: activeTables.map(table => `${table.tableName}${table.domain ? ` [domain: ${table.domain}]` : ''}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`).join('\n').slice(0, 12000)
  };
}

function refineSchemaContext(query, requestedTableNames = [], options = {}) {
  const dbName = options.dbName || null;
  const dbSourceId = options.dbSourceId || null;
  const activeTables = dictionaryService.getGroupedTables().filter(table => table.isActive
    && (!dbName || table.dbName === dbName)
    && (!dbSourceId || !table.dbSourceId || table.dbSourceId === dbSourceId));
  const requested = new Set(requestedTableNames.map(name => String(name).toLowerCase()));
  const selected = activeTables.filter(table => requested.has(table.tableName.toLowerCase())).slice(0, MAX_TABLES);
  if (selected.length === 0) return null;
  const selectedNames = new Set(selected.map(table => table.tableName));
  const enrichmentRelations = selected.length === 1 ? automaticEnrichmentRelations(selected[0], activeTables) : [];
  const joinPlan = enrichmentRelations.length
    ? joinPlannerService.planEnrichment(tableIdentity(selected[0]), enrichmentRelations, { dbSourceId })
    : process.env.SQL_JOIN_PLANNER_ENABLED === 'true' && selected.length > 1
      ? joinPlannerService.planJoin(selected.slice(0, MAX_TABLES).map(table => tableIdentity(table)), {
        dbSourceId, maxEdges: JOIN_MAX_EDGES,
        rootTableId: tableIdentity(selected[0]), expectedGrain: 'root',
        parallelRelationshipIds: dictionaryService.getTableRelationships()
          .filter(relation => relation.isActive !== false && relation.status === 'verified'
            && relationshipRelevant(tokens(query), relation, activeTables)).map(relation => relation.id)
      }) : null;
  if (joinPlan?.outcome === 'ready') for (const ref of joinPlan.tableRefs) {
    if (selected.some(table => tableIdentity(table) === ref.tableId) || selected.length >= MAX_TABLES) continue;
    const bridge = activeTables.find(table => tableIdentity(table) === ref.tableId);
    if (bridge) { selected.push(bridge); selectedNames.add(bridge.tableName); }
  }
  let relationships = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified')
    .filter(relation => selected.some(table => tableIdentity(table) === relation.sourceTableId)
      || selected.some(table => tableIdentity(table) === relation.targetTableId));
  if (joinPlan?.outcome === 'ready' && joinPlan.edges.length) {
    const plannedIds = new Set(joinPlan.edges.map(edge => edge.relationshipId));
    relationships = relationships.filter(relation => plannedIds.has(relation.id));
  }
  for (const relation of relationships) {
    for (const relatedId of [relation.sourceTableId, relation.targetTableId]) {
      if (!selected.some(table => tableIdentity(table) === relatedId) && selected.length < MAX_TABLES) {
        const table = activeTables.find(item => tableIdentity(item) === relatedId);
        if (table) { selected.push(table); selectedNames.add(table.tableName); }
      }
    }
  }
  const lines = [];
  const requiredColumns = new Map();
  const relationshipMappedColumns = new Set();
  relationships.forEach(relation => (relation.columnPairs || []).forEach(pair => {
    if (relation.businessRole && relation.displayColumn) relationshipMappedColumns.add(`${relation.sourceTableId}\u0000${pair.sourceColumn}`);
    requiredColumns.set(relation.sourceTableId, new Set([...(requiredColumns.get(relation.sourceTableId) || []), pair.sourceColumn]));
    requiredColumns.set(relation.targetTableId, new Set([...(requiredColumns.get(relation.targetTableId) || []), pair.targetColumn]));
    if (relation.displayColumn) requiredColumns.set(relation.targetTableId, new Set([...(requiredColumns.get(relation.targetTableId) || []), relation.displayColumn]));
  }));
  for (const table of selected) {
    const rankedColumns = selectColumns(table, query, new Set());
    const mandatory = requiredColumns.get(tableIdentity(table)) || new Set();
    const columns = [...rankedColumns, ...(table.columns || []).filter(column => column.isVisible !== false && mandatory.has(column.columnName) && !rankedColumns.some(item => item.columnName === column.columnName))];
    const defaults = table.defaultMetric || table.defaultTimeColumn
      ? ` [Defaults: metric=${table.defaultMetric || 'none'}, time=${table.defaultTimeColumn || 'none'}, aggregation=${table.defaultAggregation || 'SUM'}]` : '';
    lines.push(`Table ${table.tableName}${table.domain ? ` [Business domain: ${table.domain}]` : ''}${defaults}${table.tableDescription ? ` — ${table.tableDescription}` : ''}`);
    lines.push(`Columns: ${columns.map(column => `${column.columnName} ${column.dataType}${column.isPrimaryKey ? ' PK' : ''}${column.displayName && !relationshipMappedColumns.has(`${tableIdentity(table)}\u0000${column.columnName}`) ? ` [result header: ${column.displayName}]` : ''}${column.description ? ` (${column.description})` : ''}`).join('; ')}`);
  }
  if (relationships.length) {
    lines.push('Relationships:');
    relationships.forEach(relation => lines.push(`- ${(relation.columnPairs || []).map(pair => `${relation.sourceTable}.${pair.sourceColumn} -> ${relation.targetTable}.${pair.targetColumn}`).join(' AND ')} (${relation.cardinality || relation.relationType || 'related'}; display=${relation.displayColumn || 'unspecified'})`));
    if (joinPlan?.purpose === 'enrichment') lines.push('Auto-enrichment requirement: when returning rows from the primary table, JOIN every relationship listed above and include the mapped display column instead of its foreign-key ID. Alias each mapped display value with the exact relationship role as the result header. Order result columns as identity Code/Name fields, mapped display values, other business fields, then unmapped ID fields. Use each planned alias separately when several fields point to the same lookup table.');
  }
  if (joinPlan) {
    joinPlan.allowedTableIds = selected.map(table => tableIdentity(table));
    joinPlan.allowedTableNames = selected.map(table => table.tableName);
    joinPlan.dbSourceId ||= dbSourceId;
  }
  return {
    mode: 'data', useTools: true,
    schemaContext: lines.join('\n').slice(0, MAX_CONTEXT_CHARS),
    selectedTables: selected.map(table => table.tableName),
    selectedTableIds: selected.map(table => tableIdentity(table)),
    joinPlan,
    retrieval: { strategy: 'model_table_selector', activeTableCount: activeTables.length }
  };
}

module.exports = { buildSchemaContext, refineSchemaContext, isStandaloneCalculation };
