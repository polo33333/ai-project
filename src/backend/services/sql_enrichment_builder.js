'use strict';

function quote(name) { return `[${String(name).replace(/\]/g, ']]')}]`; }
function outputAlias(edge, index) { return String(edge.businessRole || '').trim() || `RelatedValue${index + 1}`; }

function isSimpleEntityListRequest(text = '') {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().trim();
  const tail = normalized.replace(/^(?:ds|danh sach|liet ke|cho (?:(?:toi|minh)\s+)?xem)\s+/, '').trim();
  if (!tail || tail === normalized || /\d/.test(tail)) return false;
  return tail.split(/\s+/).filter(Boolean).length <= 2;
}

function extractNamedEntityValue(question = '') {
  const input = String(question).trim();
  const match = input.match(/t[eê]n\s*(?:l[aà])?\s*[:"']?\s*(.+)$/iu);
  const entityAfterSubject = input.match(/(?:nh[aâ]n\s*vi[eê]n|nv)\s+([\p{L}\p{N}][\p{L}\p{N}\s.'-]*)$/iu);
  const candidate = match?.[1] || entityAfterSubject?.[1] || '';
  if (!candidate || /^(?:n[aà]y|tr[eê]n|đ[oó]|v[aà]y)(?:\s|$)/iu.test(candidate.trim())) return '';
  return candidate
    .replace(/\s+(?:trong|thu[oộ]c|[oở])\s+(?:b[aả]ng\s+)?[\s\S]*$/iu, '')
    .replace(/\s+l[aà]\s+(?:g[iì]|bao\s+nhi[eê]u)[\s\S]*$/iu, '')
    .replace(/\s+(?:kh[oô]ng|khong|ko)(?:\s+(?:v[aậ]y|n[aà]o))?\s*$/iu, '')
    .replace(/[?.!,;:"']+$/g, '')
    .trim();
}

function contextualLookupQuestion(question = '', messages = []) {
  if (extractNamedEntityValue(question)) return String(question);
  const previousEntity = [...messages].reverse()
    .filter(message => message?.role === 'user' && message.content !== question)
    .map(message => String(message.content || ''))
    .map(content => extractNamedEntityValue(content))
    .find(Boolean);
  return previousEntity ? `${String(question).trim()} tên ${previousEntity}` : String(question);
}

function mappedValueFilters(question = '', joinPlan = null, refs = new Map()) {
  const lowerQuestion = String(question).toLocaleLowerCase('vi');
  const ignored = new Set(['là', 'la', 'có', 'co', 'không', 'khong', 'ko', 'nào', 'nao', 'gì', 'gi']);
  return (joinPlan?.edges || []).flatMap(edge => {
    if (!edge.displayColumn || !edge.businessRole) return [];
    const subject = String(edge.businessRole).split(/\s+của\s+/i)[0].trim().toLocaleLowerCase('vi');
    const index = lowerQuestion.indexOf(subject);
    if (index < 0) return [];
    const value = String(question).slice(index + subject.length).match(/[\p{L}\p{N}]+/gu)?.find(token => !ignored.has(token.toLocaleLowerCase('vi')));
    const target = refs.get(edge.toTableRefId || edge.toTableId);
    if (!value || !target) return [];
    return [`${target.alias}.${quote(edge.displayColumn)} LIKE N'%${value.replace(/'/g, "''")}%'`];
  });
}

function sqlValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `N'${String(value).replace(/'/g, "''")}'`;
}

function datasetEntityFilter(reference = null, plan = {}, rootAlias = 't1') {
  if (reference?.type !== 'lastDataset' || reference.data?.table !== plan.table) return '';
  const allowed = new Set((plan.schemaColumns || []).map(key));
  const entities = (reference.data.entityKeys || []).slice(0, 50).map(entity =>
    Object.entries(entity || {}).filter(([column, value]) => allowed.has(key(column))
      && value !== null && value !== undefined && value !== ''))
    .filter(entries => entries.length);
  if (!entities.length) return '';
  return `(${entities.map(entries => `(${entries.map(([column, value]) => `${rootAlias}.${quote(column)} = ${sqlValue(value)}`).join(' AND ')})`).join(' OR ')})`;
}

function buildEnrichmentProjection(schemaColumns = [], joinPlan = null, rootAlias = 't1', displayNames = {}) {
  if (joinPlan?.outcome !== 'ready' || !joinPlan.edges?.length) return `${rootAlias}.*`;
  const refs = new Map(joinPlan.tableRefs.map(ref => [ref.tableRefId || ref.tableId, ref]));
  const relatedValues = joinPlan.edges.map((edge, index) => {
    const to = refs.get(edge.toTableRefId || edge.toTableId);
    return edge.displayColumn && to ? `${to.alias}.${quote(edge.displayColumn)} AS ${quote(outputAlias(edge, index))}` : `${to?.alias || `t${index + 2}`}.*`;
  });
  const mappedIds = new Set(joinPlan.edges.filter(edge => edge.displayColumn)
    .flatMap(edge => (edge.columnPairs || []).map(pair => String(pair.sourceColumn).toLowerCase())));
  const rootColumns = schemaColumns.filter(column => column && !/password|pwd|secret|token|credential|api.?key/i.test(column));
  if (!rootColumns.length) return [`${rootAlias}.*`, ...relatedValues].join(', ');
  const identityColumns = rootColumns.filter(column => !/id$/i.test(column) && /(?:code|name)$/i.test(column));
  const regularColumns = rootColumns.filter(column => !/id$/i.test(column) && !identityColumns.includes(column));
  const remainingIds = rootColumns.filter(column => /id$/i.test(column) && !mappedIds.has(String(column).toLowerCase()));
  const selectColumn = column => `${rootAlias}.${quote(column)}${displayNames[column] ? ` AS ${quote(displayNames[column])}` : ''}`;
  return [...identityColumns.map(selectColumn), ...relatedValues,
    ...regularColumns.map(selectColumn), ...remainingIds.map(selectColumn)].join(', ');
}

function buildEnrichedListSql(plan = {}, joinPlan = null) {
  if (!['list', 'record_lookup'].includes(plan.intent) || joinPlan?.outcome !== 'ready' || !joinPlan.edges?.length) return '';
  const limit = Math.max(1, Math.min(1000, Number(plan.rowLimit) || 100));
  const root = joinPlan.tableRefs.find(ref => ref.tableName === plan.table) || joinPlan.tableRefs[0];
  const refs = new Map(joinPlan.tableRefs.map(ref => [ref.tableRefId || ref.tableId, ref]));
  const joins = joinPlan.edges.map(edge => {
    const from = refs.get(edge.fromTableRefId || edge.fromTableId);
    const to = refs.get(edge.toTableRefId || edge.toTableId);
    if (!from || !to) return '';
    const on = (edge.columnPairs || []).map(pair => `${from.alias}.${quote(pair.sourceColumn)} = ${to.alias}.${quote(pair.targetColumn)}`).join(' AND ');
    return on ? `${edge.joinType || 'LEFT'} JOIN ${quote(to.schemaName || 'dbo')}.${quote(to.tableName)} ${to.alias} ON ${on}` : '';
  }).filter(Boolean).join(' ');
  if (!root || !joins) return '';
  const projection = buildEnrichmentProjection(plan.schemaColumns || [], joinPlan, root.alias, plan.columnDisplayNames || {});
  const filters = mappedValueFilters(plan.question, joinPlan, refs);
  const referencedEntities = datasetEntityFilter(plan.datasetReference, plan, root.alias);
  if (referencedEntities) filters.push(referencedEntities);
  const entityValue = extractNamedEntityValue(plan.question);
  const tableBase = String(plan.table || root.tableName || '').replace(/^[A-Z]+_/i, '');
  const nameColumn = (plan.schemaColumns || []).find(column => key(column) === key(`${tableBase}Name`))
    || (plan.schemaColumns || []).find(column => /name$/i.test(column));
  if (entityValue && nameColumn) filters.push(`${root.alias}.${quote(nameColumn)} LIKE N'%${entityValue.replace(/'/g, "''")}%'`);
  if (plan.intent === 'record_lookup' && !filters.length) return '';
  return `SELECT TOP ${limit} ${projection} FROM ${quote(root.schemaName || 'dbo')}.${quote(root.tableName)} ${root.alias} ${joins}${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`;
}

function key(value) { return String(value || '').toLowerCase(); }

module.exports = { buildEnrichedListSql, buildEnrichmentProjection, contextualLookupQuestion, datasetEntityFilter, extractNamedEntityValue, isSimpleEntityListRequest, mappedValueFilters };
