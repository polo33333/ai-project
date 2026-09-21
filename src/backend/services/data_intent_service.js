'use strict';

const dictionaryService = require('./dictionary_service');
const relationshipService = require('./relationship_service');

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}
function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, details });
}
function allowedTables(context = {}) {
  const ids = new Set(context.joinPlan?.allowedTableIds || context.selectedTableIds || []);
  const names = new Set((context.joinPlan?.allowedTableNames || context.selectedTables || []).map(normalize));
  return dictionaryService.getGroupedTables().filter(table => table.isActive !== false
    && ((!ids.size && !names.size) || ids.has(table.tableId) || names.has(normalize(table.tableName)))
    && (!context.dbSourceId || !table.dbSourceId || table.dbSourceId === context.dbSourceId));
}
function matchRelationshipFilter(input, edges = []) {
  const id = String(input.relationshipId || '').trim();
  const role = normalize(input.relationshipRole);
  const candidates = edges.filter(edge => (id && edge.relationshipId === id)
    || (role && (normalize(edge.businessRole) === role
      || normalize(edge.businessRole).startsWith(`${role} cua `)
      || role.startsWith(`${normalize(edge.businessRole)} cua `))));
  if (candidates.length !== 1) fail('DATA_INTENT_RELATIONSHIP_INVALID',
    candidates.length ? `Vai trò quan hệ "${input.relationshipRole}" còn mơ hồ.` : `Không tìm thấy quan hệ "${input.relationshipRole || id}" trong JOIN plan.`,
    { relationshipRole: input.relationshipRole || null, relationshipId: id || null });
  const edge = candidates[0];
  if (!String(input.value ?? '').trim()) fail('DATA_INTENT_FILTER_INVALID', 'Bộ lọc quan hệ phải có giá trị.');
  return { relationshipId: edge.relationshipId, relationshipRole: edge.businessRole || input.relationshipRole,
    displayColumn: edge.displayColumn, operator: input.operator || 'contains', value: String(input.value).trim() };
}
function availableEdges(context, tables) {
  if (context.joinPlan?.edges?.length) return context.joinPlan.edges;
  const ids = new Set(tables.map(table => table.tableId));
  return relationshipService.verifiedRelationships({ dbSourceId: context.dbSourceId })
    .filter(relation => ids.has(relation.sourceTableId) && ids.has(relation.targetTableId))
    .map(relation => ({ relationshipId: relation.id, fromTableId: relation.sourceTableId,
      toTableId: relation.targetTableId, businessRole: relation.businessRole || '',
      displayColumn: relation.displayColumn || '', columnPairs: relation.columnPairs || [] }));
}

function relationshipForRootField(edges, rootTableId, field) {
  const matches = (edges || []).filter(edge => (edge.columnPairs || []).some(pair => {
    if (edge.fromTableId === rootTableId) return normalize(pair.sourceColumn) === normalize(field);
    if (edge.toTableId === rootTableId) return normalize(pair.targetColumn) === normalize(field);
    return false;
  }) && edge.displayColumn);
  return matches.length === 1 ? matches[0] : null;
}

function isTemporalColumn(column = {}) {
  return /date|time/.test(normalize(column.dataType))
    || /date|time/.test(normalize(column.columnName));
}

function positiveInteger(value) {
  const match = String(value ?? '').match(/\d+/);
  const number = match ? Number(match[0]) : 0;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function validateIntentPlan(input = {}, context = {}) {
  const tables = allowedTables(context);
  const root = tables.find(table => normalize(table.tableName) === normalize(input.rootTable));
  if (!root) fail('DATA_INTENT_TABLE_INVALID', `Bảng gốc "${input.rootTable || ''}" không thuộc schema context hiện tại.`);
  const allowedIntents = ['list', 'record_lookup', 'aggregate', 'aggregate_timeseries', 'clarification'];
  const intent = allowedIntents.includes(input.intent) ? input.intent : null;
  if (!intent) fail('DATA_INTENT_INVALID', 'Intent không hợp lệ.');
  if (intent === 'clarification') {
    if (!String(input.clarification || '').trim()) fail('DATA_INTENT_INVALID', 'Intent clarification phải có câu hỏi làm rõ.');
    return { version: 1, intent, rootTable: root.tableName, clarification: String(input.clarification).trim(),
      confidence: Number(input.confidence) || 0 };
  }
  const visibleColumns = (root.columns || []).filter(column => column.isVisible !== false);
  const edges = availableEdges(context, tables);
  let entityLookup = input.entityLookup?.value ? {
    field: visibleColumns.find(column => normalize(column.columnName) === normalize(input.entityLookup.field))?.columnName,
    operator: input.entityLookup.operator || 'contains', value: String(input.entityLookup.value).trim()
  } : null;
  if (entityLookup && !entityLookup.field) fail('DATA_INTENT_FIELD_INVALID',
    `Cột lookup "${input.entityLookup.field || ''}" không thuộc bảng ${root.tableName}.`);
  const requestedTimeField = input.temporalFilter?.field
    || (intent === 'aggregate_timeseries' ? context.requestPlan?.timeColumn : null);
  const temporalColumn = requestedTimeField
    ? visibleColumns.find(column => normalize(column.columnName) === normalize(requestedTimeField))
    : null;
  if (input.temporalFilter?.field && (!temporalColumn || !isTemporalColumn(temporalColumn))) {
    fail('DATA_INTENT_FIELD_INVALID', `Temporal filter field "${input.temporalFilter.field}" is not a date/time column of ${root.tableName}.`);
  }
  let temporalFilter = temporalColumn ? {
    field: temporalColumn.columnName,
    mode: input.temporalFilter?.mode || 'latest_available_months',
    count: positiveInteger(input.temporalFilter?.count ?? context.requestPlan?.temporalMonths),
    from: String(input.temporalFilter?.from || '').trim() || null,
    to: String(input.temporalFilter?.to || '').trim() || null
  } : null;
  // Small models sometimes classify a time window as an entity value. Convert
  // it so SQL is not forced to compare a date column with natural-language text.
  if (entityLookup && intent === 'aggregate_timeseries') {
    const lookupColumn = visibleColumns.find(column => normalize(column.columnName) === normalize(entityLookup.field));
    if (isTemporalColumn(lookupColumn)) {
      temporalFilter = temporalFilter || {
        field: lookupColumn.columnName,
        mode: 'latest_available_months',
        count: positiveInteger(entityLookup.value) || positiveInteger(context.requestPlan?.temporalMonths),
        from: null,
        to: null
      };
      entityLookup = null;
    }
  }
  if (temporalFilter?.mode === 'latest_available_months' && !temporalFilter.count) {
    fail('DATA_INTENT_FILTER_INVALID', 'Latest-month temporal filter requires a positive month count.');
  }
  if (temporalFilter?.mode === 'calendar_range' && !temporalFilter.from && !temporalFilter.to) {
    fail('DATA_INTENT_FILTER_INVALID', 'Calendar-range temporal filter requires from or to.');
  }
  const relationshipFilters = (input.relationshipFilters || []).map(filter =>
    matchRelationshipFilter(filter, edges));
  // Foreign-key values such as GenderID="Female" describe a mapped business
  // attribute. Normalize them through verified relationship metadata instead
  // of forcing SQL to compare a numeric ID with a display value.
  if (entityLookup) {
    const edge = relationshipForRootField(edges, root.tableId, entityLookup.field);
    if (edge) {
      relationshipFilters.push(matchRelationshipFilter({
        relationshipId: edge.relationshipId,
        relationshipRole: edge.businessRole,
        operator: entityLookup.operator,
        value: entityLookup.value
      }, edges));
      entityLookup = null;
    }
  }
  const requestedFields = (input.requestedFields || []).map(field => {
    const column = visibleColumns.find(item => normalize(item.columnName) === normalize(field)
      || normalize(item.displayName) === normalize(field));
    if (column) return column.columnName;
    const edge = edges.find(item => normalize(item.businessRole) === normalize(field));
    if (edge) return edge.businessRole;
    fail('DATA_INTENT_FIELD_INVALID', `Trường kết quả "${field}" không thuộc schema/relationship context.`);
  });
  if (!entityLookup && !relationshipFilters.length && intent === 'record_lookup') {
    fail('DATA_INTENT_FILTER_INVALID', 'Record lookup cần entityLookup hoặc ít nhất một relationship filter.');
  }
  return { version: 1, intent, rootTable: root.tableName, rootTableId: root.tableId,
    entityLookup, temporalFilter, relationshipFilters, requestedFields: [...new Set(requestedFields)],
    resultGrain: String(input.resultGrain || root.tableName), confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)) };
}

function sqlContainsValue(sql, value) {
  const escaped = String(value).replace(/'/g, "''").toLowerCase();
  return String(sql).toLowerCase().includes(`'${escaped}'`)
    || String(sql).toLowerCase().includes(`'%${escaped}%'`);
}
function validateSqlAgainstIntent(sql, plan, joinPlan) {
  if (!plan || plan.intent === 'clarification') return { valid: false, code: 'DATA_INTENT_REQUIRED', error: 'SQL cần một data intent plan có thể thực thi.' };
  const text = String(sql || '');
  if (!new RegExp(`\\b${String(plan.rootTable).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
    return { valid: false, code: 'DATA_INTENT_SQL_MISMATCH', error: `SQL không dùng bảng gốc ${plan.rootTable} đã được model chọn.` };
  }
  if (plan.entityLookup && (!new RegExp(`\\b${String(plan.entityLookup.field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
      || !sqlContainsValue(text, plan.entityLookup.value))) {
    return { valid: false, code: 'DATA_INTENT_SQL_MISMATCH', error: `SQL không áp dụng entity lookup ${plan.entityLookup.field} theo intent plan.` };
  }
  if (plan.temporalFilter
      && !new RegExp(`\\b${String(plan.temporalFilter.field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
    return { valid: false, code: 'DATA_INTENT_SQL_MISMATCH',
      error: `SQL does not apply temporal filter ${plan.temporalFilter.field} from the intent plan.` };
  }
  for (const filter of plan.relationshipFilters || []) {
    const edge = (joinPlan?.edges || []).find(item => item.relationshipId === filter.relationshipId);
    const displayColumn = edge?.displayColumn || filter.displayColumn;
    if (!displayColumn || !new RegExp(`\\b${String(displayColumn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
        || !sqlContainsValue(text, filter.value)) {
      return { valid: false, code: 'DATA_INTENT_SQL_MISMATCH',
        error: `SQL chưa áp dụng bộ lọc quan hệ "${filter.relationshipRole}" với giá trị "${filter.value}".` };
    }
  }
  return { valid: true };
}

module.exports = { normalize, validateIntentPlan, validateSqlAgainstIntent };
