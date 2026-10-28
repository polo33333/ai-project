/** Dynamic schema retrieval: Qdrant + lexical matching + glossary expansion. */

const dictionaryService = require('../services/dictionary_service');
const qdrantService = require('../services/qdrant_service');
const domainAliasService = require('./domain_alias_service');
const { tableIdentity } = require('../services/schema_identity');
const joinPlannerService = require('../services/join_planner_service');
const { isSimpleEntityListRequest } = require('../services/sql_enrichment_builder');

const MAX_TABLES = Math.max(1, parseInt(process.env.AI_SCHEMA_MAX_TABLES || '6', 10));
const MAX_COLUMNS_PER_TABLE = Math.max(5, parseInt(process.env.AI_SCHEMA_MAX_COLUMNS_PER_TABLE || '40', 10));
const MAX_CONTEXT_CHARS = Math.max(2000, parseInt(process.env.AI_SCHEMA_MAX_CONTEXT_CHARS || '18000', 10));
const JOIN_MAX_EDGES = Math.max(1, Math.min(20, parseInt(process.env.SQL_JOIN_MAX_EDGES || '3', 10) || 3));
const SEMANTIC_MIN_SCORE = Math.max(0, Math.min(1, Number(process.env.AI_SCHEMA_SEMANTIC_MIN_SCORE || 0.5)));
// "thông tin", "danh sách", "các"… appear in almost every question and description, so they only add noise to table ranking.
const STOP_WORDS = new Set(['ai', 'ban', 'toi', 'la', 'cho', 'cua', 'va', 'voi', 'nay', 'kia', 'gi', 'co', 'khong', 'hay', 'theo', 'trong', 'duoc',
  'thong', 'tin', 'danh', 'sach', 'cac', 'nhung', 'nao', 'nhieu']);

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\W]+/g, ' ')
    .toLowerCase().trim();
}

// A whole message that is only a greeting or thanks ("hi", "chào bạn", "cảm ơn").
const SOCIAL = /^(hi|hello|hey|chao|xin chao|cam on|thank you|thanks)(\s+ban)?[.!?\s]*$/;
const isSocialMessage = query => SOCIAL.test(normalize(query));

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

// Generated column descriptions ("Cột X trong bảng SQL Server T") carry no meaning and match "bảng/cột" in every table.
const isGeneratedColumnDescription = (column, table) => column.description === `Cột ${column.columnName} trong bảng SQL Server ${table.tableName}`;

function tableText(table) {
  return [table.tableName, table.dbName, table.domain, domainText(table.domain), table.tableDescription,
    table.semanticModel?.entity, table.semanticModel?.grain, ...(table.semanticModel?.aliases || []), ...(table.semanticModel?.segments || []).map(s=>s.label),
    table.defaultMetric, table.defaultTimeColumn, table.defaultAggregation,
    ...(table.columns || []).filter(column => column.isVisible !== false).flatMap(column => [column.columnName, column.displayName,
      isGeneratedColumnDescription(column, table) ? '' : column.description, column.dataType])
  ].filter(Boolean).join(' ');
}

// What the table IS: name, business entity, aliases, domain and the opening phrase of its description.
// Only the first clause counts; long first sentences ("…, liên kết khách hàng bằng CustomerID") would dilute it.
function tableIdentityText(table) {
  return [table.tableName, table.domain, domainText(table.domain), table.semanticModel?.entity, ...(table.semanticModel?.aliases || []),
    String(table.tableDescription || '').split(/[.;,:(]/)[0]].filter(Boolean).join(' ');
}

// Identity matches count twice, so a table whose columns merely mention a word does not outrank the table that is that thing.
function tableScore(queryTokens, table) {
  return lexicalScore(queryTokens, tableText(table)) + lexicalScore(queryTokens, tableIdentityText(table));
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
  // "bằng Gemini" is ordinary conversation, not a request about a "bảng".
  const normalized = normalize(String(query || '').replace(/\bbằng\b/giu, ' '));
  // SQL types and generic output formats are not evidence of a database request.
  const hasSchemaMatch = tables.some(table => lexicalScore(queryTokens, [
    table.tableName, table.domain, domainText(table.domain), table.tableDescription,
    table.semanticModel?.entity, ...(table.semanticModel?.aliases || []),
    ...(table.columns || []).filter(column => column.isVisible !== false)
      .flatMap(column => [column.columnName, column.displayName, column.description])
  ].filter(Boolean).join(' ')) >= 4);
  const dataIntent = /\b(truy van|du lieu (?:trong|tu) (?:database|db|bang)|(?:database|db|bang|cot) (?:hien tai|da ket noi)|(?:bao cao|thong ke|danh sach|ds|chi tiet|bieu do|do thi)\b.*\b(?:doanh thu|hop dong|nhan vien|khach hang|hoa don)|hop dong)\b/.test(normalized);
  const generalExplanation = /\b(giai thich|huong dan|la gi|khai niem|explain|what is|how to|tutorial)\b/.test(normalized);
  const explicitStoredData = /\b(kho du lieu|noi bo|da ket noi|trong bang|tu bang|theo du lieu)\b/.test(normalized)
    || tables.some(table => ` ${normalized} `.includes(` ${normalize(table.tableName)} `));
  const greeting = SOCIAL.test(normalized);
  const standaloneCalculation = isStandaloneCalculation(query, { hasSchemaMatch });
  return greeting || standaloneCalculation || (generalExplanation && !explicitStoredData && !hasGlossaryExpansion)
    || (!hasGlossaryExpansion && !dataIntent && !hasSchemaMatch);
}

function expandWithGlossary(query) {
  query = require('../utils/entity_list_query')(query);
  const normalizedQuery = ` ${normalize(query)} `;
  const expansions = dictionaryService.getGlossary()
    .filter(item => item.isActive !== false && normalizedQuery.includes(` ${normalize(item.term)} `))
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

function automaticEnrichmentRelations(rootTable, activeTables, options = {}) {
  if (!rootTable || process.env.SQL_JOIN_PLANNER_ENABLED !== 'true') return [];
  const limit = Math.max(0, Number(process.env.SQL_AUTO_ENRICH_MAX_RELATIONSHIPS || 6));
  if (options.operation === 'list' && !options.attributes?.length) return [];
  return dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified')
    .filter(relation => relation.sourceTableId === tableIdentity(rootTable))
    .filter(relation => ['many-to-one', 'one-to-one'].includes(relation.cardinality || relation.relationType))
    .filter(relation => !options.attributes?.length || options.attributes.some(attribute =>
      [relation.businessRole, relation.displayColumn, ...(relation.columnPairs || []).map(pair=>pair.sourceColumn)]
        .some(value=>value&&normalize(value)===normalize(attribute))))
    .filter(relation => activeTables.some(table => tableIdentity(table) === relation.targetTableId))
    .filter(relation => (relation.columnPairs || []).length > 0 && relation.columnPairs.every(pair => {
      const column = (rootTable.columns || []).find(item => item.columnName === pair.sourceColumn);
      return Boolean(column?.description?.trim());
    }))
    .slice(0, limit);
}

function expandBusinessPaths(selected, activeTables, query, options = {}) {
  if(!selected.length||process.env.SQL_JOIN_PLANNER_ENABLED!=='true')return;
  const service=require('../services/relationship_service'),padded=` ${normalize(query)} `;
  const targets=[...new Set(service.verifiedRelationships(options).filter(relation=>relation.businessRole
    && (padded.includes(` ${normalize(relation.businessRole)} `)||(options.attributes||[]).some(attribute=>normalize(attribute)===normalize(relation.businessRole))))
    .map(relation=>relation.targetTableId))];
  for(const target of targets) {
    if(selected.some(table=>tableIdentity(table)===target))continue;
    const paths=service.findPaths(tableIdentity(selected[0]),target,{...options,maxEdges:JOIN_MAX_EDGES});
    if(paths.length!==1)continue;
    const needed=[...new Set(paths[0].flatMap(edge=>[edge.fromTableId,edge.toTableId]))]
      .filter(id=>!selected.some(table=>tableIdentity(table)===id)).map(id=>activeTables.find(table=>tableIdentity(table)===id));
    if(needed.some(table=>!table)||selected.length+needed.length>MAX_TABLES)continue;
    selected.push(...needed);
  }
}

function matchExplicitTable(query, tables) {
  const padded = ` ${normalize(query)} `;
  // Domain keywords describe a family of tables, never a table identity.
  const tiers = [
    table => [table.tableName, `${table.schemaName || 'dbo'}.${table.tableName}`],
    table => [table.semanticModel?.entity, ...(table.semanticModel?.aliases || [])]
  ];
  for (const names of tiers) {
    const matches = tables.filter(table => names(table).some(term => normalize(term) && padded.includes(` ${normalize(term)} `)));
    if (matches.length) return matches.length === 1 ? matches[0] : null;
  }
  return null;
}

function explicitListTable(query, options = {}) {
  query = require('../utils/entity_list_query')(query);
  if (!isSimpleEntityListRequest(query)) return null;
  const tables = dictionaryService.getGroupedTables().filter(table => table.isActive
    && (!options.dbName || table.dbName === options.dbName)
    && (!options.dbSourceId || !table.dbSourceId || table.dbSourceId === options.dbSourceId));
  return matchExplicitTable(query, tables) || matchExplicitTable(expandWithGlossary(query), tables);
}

async function buildSchemaContext(query, options = {}) {
  query = require('../utils/entity_list_query')(query);
  const dbName = options.dbName || null;
  const dbSourceId = options.dbSourceId || null;
  const activeTables = dictionaryService.getGroupedTables().filter(table => table.isActive
    && (!dbName || table.dbName === dbName)
    && (!dbSourceId || !table.dbSourceId || table.dbSourceId === dbSourceId));
  const expandedQuery = expandWithGlossary(query);
  const queryTokens = tokens(expandedQuery);
  if (!options.forceRetrieval && isGeneralConversation(query, queryTokens, activeTables, normalize(expandedQuery) !== normalize(query))) {
    return { mode: 'general', schemaContext: '', selectedTables: [], useTools: false };
  }

  const expandedTokens = tokens(expandedQuery);
  const directListTable = isSimpleEntityListRequest(query)
    ? matchExplicitTable(query, activeTables) || matchExplicitTable(expandedQuery, activeTables) : null;
  const lexicalScores = new Map(activeTables.map(table => [tableIdentity(table), tableScore(expandedTokens, table)]));
  if (directListTable) {
    for (const table of activeTables) lexicalScores.set(tableIdentity(table), table === directListTable ? 1000 : 0);
  }
  const scores = new Map(lexicalScores);
  const vectorColumnNames = new Set();
  let vectorResults = [];
  let semanticSearch = { status: 'ok', errorCode: null };
  if (!require('../services/embedding_policy').enabled()) {
    semanticSearch = { status: 'skipped', errorCode: null, reason: 'embedding_disabled' };
  } else if (directListTable) {
    semanticSearch = { status: 'skipped', errorCode: null, reason: 'explicit_list_entity' };
  } else try {
    const result = await qdrantService.searchSchema(expandedQuery, Math.max(12, MAX_TABLES * 3), { detailed: true });
    vectorResults = Array.isArray(result) ? result : result.results;
    if (!Array.isArray(vectorResults)) throw new Error('Invalid schema search result');
    if (!Array.isArray(result)) semanticSearch = { status: result.status, errorCode: result.errorCode || null };
  } catch (error) {
    semanticSearch = { status: 'degraded', errorCode: 'SCHEMA_SEARCH_FAILED' };
    console.warn(`[schema_context] Semantic search degraded: ${semanticSearch.errorCode}`);
  }

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
  const selected = tablePool.slice(0, MAX_TABLES).map(item => item.table);
  const primary = activeTables.find(table => table.tableName === options.primaryTable);
  if (primary) {
    const index = selected.indexOf(primary);
    if (index >= 0) selected.splice(index, 1);
    selected.unshift(primary);
    selected.splice(MAX_TABLES);
  }
  const semanticCandidates = [];
  const seenSemantic = new Set();
  for (const result of vectorResults) {
    if ((Number(result.score) || 0) < SEMANTIC_MIN_SCORE) continue;
    const payload = result.payload || {};
    const candidates = payload.tableId
      ? activeTables.filter(table => tableIdentity(table) === payload.tableId)
      : activeTables.filter(table => [payload.tableName, payload.sourceTable, payload.targetTable].includes(table.tableName));
    if (candidates.length !== 1) continue;
    const table = candidates[0];
    const id = tableIdentity(table);
    if (!seenSemantic.has(id)) { seenSemantic.add(id); semanticCandidates.push(table); }
  }
  if (maxLexicalScore >= 4 && MAX_TABLES > 1 && semanticCandidates.length) {
    const candidate = semanticCandidates.find(table => !selected.some(item => tableIdentity(item) === tableIdentity(table)));
    if (candidate) {
      if (selected.length >= MAX_TABLES) selected.pop();
      selected.push(candidate);
    }
  }
  expandBusinessPaths(selected,activeTables,[expandedQuery,options.question&&expandWithGlossary(options.question)].filter(Boolean).join(' '),{...options,dbSourceId});
  const selectedNames = new Set(selected.map(table => table.tableName));
  const requestedIds = selected.slice(0, MAX_TABLES).map(table => tableIdentity(table));
  const parallelRelationshipIds = dictionaryService.getTableRelationships()
    .filter(relation => relation.isActive !== false && relation.status === 'verified'
      && relationshipRelevant(expandedTokens, relation, activeTables)).map(relation => relation.id);
  const rootMappings = automaticEnrichmentRelations(selected[0], activeTables, options);
  const enrichmentRelations = selected.slice(1).every(table => rootMappings.some(relation => relation.targetTableId === tableIdentity(table)))
    ? rootMappings : [];
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
  // A semantic candidate unrelated to the root must not erase its verified
  // display mappings from the exposed schema.
  for (const relation of rootMappings) if (!relationships.some(item => item.id === relation.id)) relationships.push(relation);
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

  for (const relation of rootMappings) if (!relationships.some(item => item.id === relation.id)) relationships.push(relation);
  const lines = [require('../agent/tools/join_path').instruction];
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
    if (joinPlan?.purpose === 'enrichment') lines.push('Auto-enrichment requirement: when returning rows from the primary table, LEFT JOIN every relationship listed above unless its join type explicitly requires otherwise. Never drop a primary-table row just because a customer, employee, or status lookup is missing. Include the mapped display column instead of its foreign-key ID. Alias each mapped display value with the exact relationship role as the result header. Order result columns as identity Code/Name fields, mapped display values, other business fields, then unmapped ID fields. Use each planned alias separately when several fields point to the same lookup table.');
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
    mappedRelationships: relationships.filter(relation => relation.businessRole && relation.displayColumn).map(relation => ({
      sourceTable: relation.sourceTable, targetTable: relation.targetTable,
      businessRole: relation.businessRole, displayColumn: relation.displayColumn, columnPairs: relation.columnPairs
    })),
    retrieval: { vectorMatches: vectorResults.length, activeTableCount: activeTables.length, semanticSearch,
      candidateIds: [...new Set([...tablePool.map(item => tableIdentity(item.table)), ...semanticCandidates.map(tableIdentity), ...selected.map(tableIdentity)])] },
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
  expandBusinessPaths(selected,activeTables,[query,options.question&&expandWithGlossary(options.question)].filter(Boolean).join(' '),{...options,dbSourceId});
  const selectedNames = new Set(selected.map(table => table.tableName));
  const rootMappings = automaticEnrichmentRelations(selected[0], activeTables, options);
  const enrichmentRelations = selected.slice(1).every(table => rootMappings.some(relation => relation.targetTableId === tableIdentity(table)))
    ? rootMappings : [];
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
  const lines = [require('../agent/tools/join_path').instruction];
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

module.exports = { buildSchemaContext, refineSchemaContext, isStandaloneCalculation, explicitListTable, isSocialMessage };
