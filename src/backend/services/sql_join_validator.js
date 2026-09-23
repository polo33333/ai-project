'use strict';

const { Parser } = require('node-sql-parser/build/transactsql');
const dictionaryService = require('./dictionary_service');
const relationshipService = require('./relationship_service');
const parser = new Parser();

function key(value) { return String(value || '').toLowerCase(); }
function failure(code, error, details = {}) { return { valid: false, code, error, details }; }
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) value.forEach(item => walk(item, visit));
  else Object.values(value).forEach(item => walk(item, visit));
}
function selectStatements(ast) {
  const result = [];
  walk(ast, node => { if (node.type === 'select' && Array.isArray(node.from)) result.push(node); });
  return [...new Set(result)];
}
function cteNames(ast) {
  const names = new Set();
  walk(ast, node => { if (Array.isArray(node.with)) node.with.forEach(item => names.add(key(item.name?.value || item.name))); });
  return names;
}
function tableRef(item) {
  return { tableName: key(item.table), schemaName: key(item.db || item.schema || 'dbo'),
    alias: key(item.as || item.table), join: key(item.join), on: item.on || null };
}
function columnPair(node) {
  if (node?.type !== 'binary_expr' || node.operator !== '='
      || node.left?.type !== 'column_ref' || node.right?.type !== 'column_ref') return null;
  return { leftAlias: key(node.left.table), leftColumn: key(node.left.column),
    rightAlias: key(node.right.table), rightColumn: key(node.right.column) };
}

// Return only equalities which are mandatory. An equality below OR is not proof of a JOIN key.
function mandatoryEqualityPairs(expression) {
  if (!expression) return { supported: false, pairs: [] };
  if (expression.type === 'binary_expr' && String(expression.operator).toUpperCase() === 'AND') {
    const left = mandatoryEqualityPairs(expression.left);
    const right = mandatoryEqualityPairs(expression.right);
    return { supported: left.supported && right.supported, pairs: [...left.pairs, ...right.pairs] };
  }
  if (expression.type === 'binary_expr' && String(expression.operator).toUpperCase() === 'OR') {
    return { supported: false, pairs: [] };
  }
  const pair = columnPair(expression);
  return { supported: true, pairs: pair ? [pair] : [] };
}

function refForEdge(plan, edge, side) {
  const refId = edge[`${side}TableRefId`];
  const tableId = edge[`${side}TableId`];
  return (plan.tableRefs || []).find(ref => refId ? ref.tableRefId === refId : ref.tableId === tableId);
}
function edgeMatches(edge, plan, leftRef, rightRef, pairs) {
  const from = refForEdge(plan, edge, 'from');
  const to = refForEdge(plan, edge, 'to');
  if (!from || !to) return false;
  const samePhysicalTable = (planRef, sqlRef) => key(planRef.tableName) === sqlRef.tableName
    && key(planRef.schemaName || 'dbo') === sqlRef.schemaName;
  const direct = samePhysicalTable(from, leftRef) && samePhysicalTable(to, rightRef);
  const reverse = samePhysicalTable(from, rightRef) && samePhysicalTable(to, leftRef);
  if (!direct && !reverse) return false;
  const leftAlias = leftRef.alias;
  const rightAlias = rightRef.alias;
  return (edge.columnPairs || []).every(pair => pairs.some(predicate => {
    const sourceAlias = direct ? leftAlias : rightAlias;
    const targetAlias = direct ? rightAlias : leftAlias;
    return (predicate.leftAlias === sourceAlias && predicate.leftColumn === key(pair.sourceColumn)
        && predicate.rightAlias === targetAlias && predicate.rightColumn === key(pair.targetColumn))
      || (predicate.rightAlias === sourceAlias && predicate.rightColumn === key(pair.sourceColumn)
        && predicate.leftAlias === targetAlias && predicate.leftColumn === key(pair.targetColumn));
  }));
}

function fallbackPlan(plan = {}) {
  const tables = dictionaryService.getGroupedTables();
  const allowedIds = new Set(plan.allowedTableIds || plan.requestedTableIds || []);
  const allowedNames = new Set((plan.allowedTableNames || []).map(key));
  if (!allowedIds.size && !allowedNames.size && !(plan.tableRefs || []).length) {
    return { ...plan, outcome: 'fallback', tableRefs: [], edges: [] };
  }
  const inScope = table => (!allowedIds.size && !allowedNames.size)
    || allowedIds.has(table.tableId) || allowedNames.has(key(table.tableName));
  const scopedTables = tables.filter(table => table.isActive !== false && inScope(table)
    && (!plan.dbSourceId || !table.dbSourceId || table.dbSourceId === plan.dbSourceId));
  const scopedIds = new Set(scopedTables.map(table => table.tableId));
  const relations = relationshipService.verifiedRelationships({ dbSourceId: plan.dbSourceId })
    .filter(relation => scopedIds.has(relation.sourceTableId) && scopedIds.has(relation.targetTableId));
  return {
    ...plan, outcome: 'fallback', tableRefs: scopedTables.map((table, index) => ({
      tableRefId: `${table.tableId}#scope-${index + 1}`, tableId: table.tableId,
      tableName: table.tableName, schemaName: table.schemaName || 'dbo'
    })),
    edges: relations.map(relation => ({ relationshipId: relation.id, revision: relation.revision,
      fromTableId: relation.sourceTableId, toTableId: relation.targetTableId,
      columnPairs: relation.columnPairs || [], cardinality: relation.cardinality || relation.relationType,
      businessRole: relation.businessRole || '', displayColumn: relation.displayColumn || '' }))
  };
}

function projectedColumns(select) {
  return (select.columns || []).map(column => ({ table: key(column.expr?.table),
    column: key(column.expr?.column), star: column.expr?.type === 'star' || key(column.expr?.column) === '*' }));
}
function aliasesForEdge(edge, plan, refs) {
  const from = refForEdge(plan, edge, 'from');
  const to = refForEdge(plan, edge, 'to');
  return { from: refs.filter(ref => ref.tableName === key(from?.tableName)).map(ref => ref.alias),
    to: refs.filter(ref => ref.tableName === key(to?.tableName)).map(ref => ref.alias) };
}
function validateGrain(select, refs, plan, usedEdges) {
  const aggregates = [];
  (select.columns || []).forEach(column => walk(column.expr, node => { if (node.type === 'aggr_func') aggregates.push(node); }));
  for (const edge of usedEdges.filter(item => item.cardinality === 'one-to-many')) {
    const aliases = aliasesForEdge(edge, plan, refs);
    for (const aggregate of aggregates) {
      const argument = aggregate.args?.expr;
      if (argument?.type !== 'column_ref' || !aliases.from.includes(key(argument.table))) continue;
      const name = key(aggregate.name);
      if (name === 'count' && aggregate.args?.distinct) continue;
      if (['sum', 'count', 'avg'].includes(name)) return failure('JOIN_GRAIN_UNSAFE',
        `${name.toUpperCase()} cột bảng cha sau JOIN một-nhiều có thể sai do fan-out; hãy giữ đúng grain thực thể trước khi aggregate.`);
    }
    if (!aggregates.length && plan.expectedGrain === 'root' && edge.fromTableId === plan.rootTableId) {
      const projected = projectedColumns(select);
      const parentProjected = projected.some(item => item.star || !item.table || aliases.from.includes(item.table));
      if (parentProjected) return failure('JOIN_GRAIN_UNSAFE',
        'JOIN một-nhiều có thể lặp dòng của thực thể chính; hãy dùng EXISTS, aggregate bảng con trước, hoặc yêu cầu grain chi tiết cha-con.');
    }
  }
  return { valid: true };
}

function validateEnrichmentProjection(select, refs, plan, bindings) {
  if (plan.purpose !== 'enrichment') return { valid: true };
  const columns = select.columns || [];
  if (!bindings.length) {
    const root = plan.tableRefs?.[0];
    const rootAliases = refs.filter(ref => ref.tableName === key(root?.tableName)).map(ref => ref.alias);
    const mappedIds = new Set((plan.edges || []).flatMap(edge => (edge.columnPairs || []).map(pair => key(pair.sourceColumn))));
    const exposesMappedId = columns.some(column => {
      if (column.expr?.type === 'star') return true;
      if (column.expr?.type !== 'column_ref') return false;
      const alias = key(column.expr.table);
      return mappedIds.has(key(column.expr.column)) && (!alias || rootAliases.includes(alias));
    });
    if (exposesMappedId) {
      const targetNames = [...new Set((plan.edges || []).map(edge => refForEdge(plan, edge, 'to')?.tableName).filter(Boolean))];
      return failure('JOIN_PROJECTION_INVALID',
        `SQL hiển thị ID đã map nhưng thiếu JOIN tới bảng hiển thị bắt buộc${targetNames.length ? `: ${targetNames.join(', ')}` : ''}.`);
    }
  }
  for (const { edge, fromAlias, toAlias } of bindings.filter(item => item.edge.displayColumn && item.edge.businessRole)) {
    const mappedSourceColumns = new Set((edge.columnPairs || []).map(pair => key(pair.sourceColumn)));
    const exposesMappedId = columns.some(column => {
      if (column.expr?.type === 'star') return true;
      if (column.expr?.type !== 'column_ref') return false;
      const selectedColumn = key(column.expr.column);
      const selectedAlias = key(column.expr.table);
      return (selectedColumn === '*' || mappedSourceColumns.has(selectedColumn)) && (!selectedAlias || selectedAlias === fromAlias);
    });
    if (exposesMappedId) return failure('JOIN_PROJECTION_INVALID',
      `SQL không được hiển thị ID đã map của quan hệ ${edge.relationshipId}; hãy chỉ hiển thị ${edge.displayColumn} với tiêu đề "${edge.businessRole}".`);
    const mappedDisplay = columns.find(column => column.expr?.type === 'column_ref'
      && key(column.expr.table) === toAlias && key(column.expr.column) === key(edge.displayColumn));
    if (!mappedDisplay) return failure('JOIN_PROJECTION_INVALID', `SQL thiếu cột hiển thị ${edge.displayColumn} của quan hệ ${edge.relationshipId}.`);
    if (String(mappedDisplay.as || '').trim() !== String(edge.businessRole).trim()) return failure('JOIN_PROJECTION_INVALID',
      `Cột ${edge.displayColumn} phải dùng đúng tiêu đề "${edge.businessRole}".`);
  }
  return { valid: true };
}

function validateSelect(select, ctes, plan) {
  const refs = (select.from || []).filter(item => item.table && !ctes.has(key(item.table))).map(tableRef);
  if (!refs.length) return { valid: true, usedEdges: [] };
  const allowed = plan.tableRefs || [];
  const outside = refs.find(ref => !allowed.some(item => key(item.tableName) === ref.tableName
    && key(item.schemaName || 'dbo') === ref.schemaName));
  if (outside) return failure('JOIN_SCOPE_DENIED',
    `SQL dùng bảng ngoài JOIN plan/phạm vi cho phép: ${outside.schemaName}.${outside.tableName}.`,
    { schemaName: outside.schemaName, tableName: outside.tableName });
  const prior = [];
  const usedEdges = [];
  const bindings = [];
  for (const ref of refs) {
    if (!ref.join) { prior.push(ref); continue; }
    if (ref.join === 'cross join' || !ref.on) return failure('JOIN_PREDICATE_INVALID', 'JOIN thiếu điều kiện ON hoặc dùng CROSS JOIN.');
    const predicates = mandatoryEqualityPairs(ref.on);
    if (!predicates.supported) return failure('JOIN_UNSUPPORTED_SQL', 'Điều kiện JOIN chứa OR nên không chứng minh được khóa JOIN bắt buộc.');
    let match = null;
    for (const left of prior) {
      const edge = (plan.edges || []).find(candidate => edgeMatches(candidate, plan, left, ref, predicates.pairs));
      if (edge) { match = { edge, fromAlias: key(refForEdge(plan, edge, 'from')?.tableName) === left.tableName ? left.alias : ref.alias,
        toAlias: key(refForEdge(plan, edge, 'to')?.tableName) === ref.tableName ? ref.alias : left.alias }; break; }
    }
    if (!match) return failure('JOIN_RELATIONSHIP_MISSING', `SQL thiếu đủ khóa JOIN hoặc quan hệ đã xác minh cho bảng ${ref.tableName}.`, { tableName: ref.tableName });
    if (plan.purpose === 'enrichment' && key(match.edge.joinType || 'LEFT') === 'left' && ref.join !== 'left join') {
      return failure('JOIN_PRESERVATION_REQUIRED',
        `Quan hệ bổ sung ${match.edge.relationshipId} cần LEFT JOIN để giữ bản ghi của bảng gốc khi thiếu dữ liệu liên kết.`);
    }
    usedEdges.push(match.edge);
    bindings.push(match);
    prior.push(ref);
  }
  const grain = validateGrain(select, refs, plan, usedEdges);
  if (!grain.valid) return grain;
  const projection = validateEnrichmentProjection(select, refs, plan, bindings);
  if (!projection.valid) return projection;
  return { valid: true, usedEdges };
}

function validateSqlAgainstJoinPlan(sql, inputPlan) {
  const enforcePlan = process.env.SQL_JOIN_PLANNER_ENABLED === 'true';
  if (!enforcePlan && (!inputPlan || inputPlan.outcome !== 'ready' || !inputPlan.edges?.length)) return { valid: true };
  let ast;
  try { ast = parser.astify(String(sql || '')); }
  catch (error) { return failure('JOIN_UNSUPPORTED_SQL', `Không phân tích được cú pháp T-SQL: ${error.message}`); }
  if (Array.isArray(ast) || ast?.type !== 'select') return failure('JOIN_UNSUPPORTED_SQL', 'JOIN plan chỉ cho phép đúng một câu SELECT/CTE.');
  const selects = selectStatements(ast);
  const containsJoin = selects.some(select => (select.from || []).some(item => item.join));
  if (!containsJoin) {
    if (!inputPlan?.edges?.length) return { valid: true };
    const readyPlan = inputPlan.outcome === 'ready' ? inputPlan : fallbackPlan(inputPlan);
    if (!readyPlan.edges.length) return { valid: true };
    return validateEnrichmentProjection(selects[selects.length - 1], (selects[selects.length - 1].from || []).map(tableRef), readyPlan, []);
  }
  const plan = inputPlan?.outcome === 'ready' && inputPlan.edges?.length ? inputPlan : fallbackPlan(inputPlan || {});
  if (!plan.edges.length) return failure('JOIN_RELATIONSHIP_MISSING',
    'Truy vấn không có backend JOIN plan hoặc quan hệ đã xác minh phù hợp.');
  const ctes = cteNames(ast);
  for (const select of selects) {
    const result = validateSelect(select, ctes, plan);
    if (!result.valid) return result;
  }
  return { valid: true };
}

module.exports = { mandatoryEqualityPairs, validateSqlAgainstJoinPlan };
