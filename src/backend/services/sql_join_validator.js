'use strict';

const { Parser } = require('node-sql-parser/build/transactsql');
const parser = new Parser();

function key(value) { return String(value || '').toLowerCase(); }
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
function tableRefs(select, ctes) {
  return (select.from || []).filter(item => item.table && !ctes.has(key(item.table))).map(item => ({
    tableName: key(item.table), alias: key(item.as || item.table), join: key(item.join), on: item.on || null
  }));
}
function equalityPairs(expression) {
  const pairs = [];
  walk(expression, node => {
    if (node.type === 'binary_expr' && node.operator === '=' && node.left?.type === 'column_ref' && node.right?.type === 'column_ref') {
      pairs.push({ leftAlias: key(node.left.table), leftColumn: key(node.left.column), rightAlias: key(node.right.table), rightColumn: key(node.right.column) });
    }
  });
  return pairs;
}
function validateAggregateGrain(selects, plan) {
  for (const select of selects) {
    const refs = tableRefs(select, new Set());
    const aliases = tableId => {
      const planRef = plan.tableRefs.find(ref => ref.tableId === tableId);
      return refs.filter(item => item.tableName === key(planRef?.tableName)).map(item => item.alias);
    };
    const aggregates = [];
    (select.columns || []).forEach(column => walk(column.expr, node => { if (node.type === 'aggr_func') aggregates.push(node); }));
    for (const edge of plan.edges) {
      const cardinality = edge.cardinality;
      if (cardinality !== 'one-to-many') continue;
      const parentAliases = aliases(edge.fromTableId);
      const childAliases = aliases(edge.toTableId);
      if (!parentAliases.length || !childAliases.length) continue;
      for (const aggregate of aggregates) {
        const argument = aggregate.args?.expr;
        if (key(aggregate.name) === 'sum' && argument?.type === 'column_ref' && parentAliases.includes(key(argument.table))) {
          return { valid: false, error: 'SUM cột bảng cha sau JOIN một-nhiều có thể nhân bản số liệu; hãy aggregate bảng con trước hoặc đổi result grain.' };
        }
        if (key(aggregate.name) === 'count' && argument?.type === 'column_ref' && parentAliases.includes(key(argument.table)) && !aggregate.args?.distinct) {
          return { valid: false, error: 'COUNT thực thể bảng cha qua JOIN một-nhiều phải dùng COUNT DISTINCT khóa thực thể hoặc aggregate trước.' };
        }
      }
    }
  }
  return { valid: true };
}

function validateEnrichmentProjection(selects, refs, plan) {
  if (plan.purpose !== 'enrichment') return { valid: true };
  const outerSelect = selects[selects.length - 1];
  const columns = outerSelect?.columns || [];
  for (const edge of plan.edges.filter(item => item.displayColumn && item.businessRole)) {
    const fromRef = plan.tableRefs.find(ref => edge.fromTableRefId ? ref.tableRefId === edge.fromTableRefId : ref.tableId === edge.fromTableId);
    const toRef = plan.tableRefs.find(ref => edge.toTableRefId ? ref.tableRefId === edge.toTableRefId : ref.tableId === edge.toTableId);
    const fromAliases = new Set(refs.filter(ref => ref.tableName === key(fromRef?.tableName)).map(ref => ref.alias));
    const toAliases = new Set(refs.filter(ref => ref.tableName === key(toRef?.tableName)).map(ref => ref.alias));
    const mappedSourceColumns = new Set((edge.columnPairs || []).map(pair => key(pair.sourceColumn)));
    const exposesMappedId = columns.some(column => {
      if (column.expr?.type === 'star') return true;
      if (column.expr?.type !== 'column_ref') return false;
      const selectedColumn = key(column.expr.column);
      const selectedAlias = key(column.expr.table);
      if (selectedColumn === '*' && (!selectedAlias || fromAliases.has(selectedAlias))) return true;
      return mappedSourceColumns.has(selectedColumn) && (!selectedAlias || fromAliases.has(selectedAlias));
    });
    if (exposesMappedId) {
      return { valid: false, error: `SQL không được hiển thị ID đã map của quan hệ ${edge.relationshipId}; hãy chỉ hiển thị ${edge.displayColumn} với tiêu đề "${edge.businessRole}".` };
    }
    const mappedDisplay = columns.find(column => column.expr?.type === 'column_ref'
      && toAliases.has(key(column.expr.table))
      && key(column.expr.column) === key(edge.displayColumn));
    if (!mappedDisplay) {
      return { valid: false, error: `SQL thiếu cột hiển thị ${edge.displayColumn} của quan hệ ${edge.relationshipId}.` };
    }
    if (String(mappedDisplay.as || '').trim() !== String(edge.businessRole).trim()) {
      return { valid: false, error: `Cột ${edge.displayColumn} phải dùng đúng tiêu đề "${edge.businessRole}".` };
    }
  }
  return { valid: true };
}

function validateSqlAgainstJoinPlan(sql, plan) {
  const enforcePlan = process.env.SQL_JOIN_PLANNER_ENABLED === 'true';
  if (!enforcePlan && (!plan || plan.outcome !== 'ready' || !Array.isArray(plan.edges) || !plan.edges.length)) return { valid: true };
  let ast;
  try { ast = parser.astify(String(sql || '')); }
  catch (error) { return { valid: false, error: `Không phân tích được cú pháp T-SQL: ${error.message}` }; }
  if (Array.isArray(ast) || ast?.type !== 'select') return { valid: false, error: 'JOIN plan chỉ cho phép đúng một câu SELECT/CTE.' };
  const selects = selectStatements(ast);
  const containsJoin = selects.some(select => (select.from || []).some(item => item.join));
  if ((!plan || plan.outcome !== 'ready') && containsJoin) return { valid: false, error: 'Truy vấn JOIN không có backend JOIN plan ở trạng thái ready.' };
  if (!plan || !Array.isArray(plan.edges) || !plan.edges.length) return { valid: true };
  const ctes = cteNames(ast);
  const refs = selects.flatMap(select => tableRefs(select, ctes));
  const allowedNames = new Set(plan.tableRefs.map(ref => key(ref.tableName)));
  const outside = refs.find(ref => !allowedNames.has(ref.tableName));
  if (outside) return { valid: false, error: `SQL dùng bảng ngoài JOIN plan: ${outside.tableName}.` };
  for (const ref of plan.tableRefs) if (!refs.some(item => item.tableName === key(ref.tableName))) return { valid: false, error: `SQL thiếu bảng bắt buộc: ${ref.tableName}.` };
  if (refs.some(ref => ref.join === 'cross join' || (ref.join && !ref.on))) return { valid: false, error: 'JOIN thiếu điều kiện ON hoặc dùng CROSS JOIN.' };
  const predicates = selects.flatMap(select => (select.from || []).flatMap(item => equalityPairs(item.on)));
  for (const edge of plan.edges) {
    const fromRef = plan.tableRefs.find(ref => edge.fromTableRefId ? ref.tableRefId === edge.fromTableRefId : ref.tableId === edge.fromTableId);
    const toRef = plan.tableRefs.find(ref => edge.toTableRefId ? ref.tableRefId === edge.toTableRefId : ref.tableId === edge.toTableId);
    const fromAliases = refs.filter(ref => ref.tableName === key(fromRef?.tableName)).map(ref => ref.alias);
    const toAliases = refs.filter(ref => ref.tableName === key(toRef?.tableName)).map(ref => ref.alias);
    const matches = fromAliases.some(left => toAliases.some(right => (edge.fromTableId !== edge.toTableId || left !== right)
      && edge.columnPairs.every(pair => predicates.some(predicate =>
        (predicate.leftAlias === left && predicate.leftColumn === key(pair.sourceColumn) && predicate.rightAlias === right && predicate.rightColumn === key(pair.targetColumn))
        || (predicate.rightAlias === left && predicate.rightColumn === key(pair.sourceColumn) && predicate.leftAlias === right && predicate.leftColumn === key(pair.targetColumn))))));
    if (!matches) return { valid: false, error: `SQL thiếu đủ khóa JOIN của quan hệ ${edge.relationshipId}.` };
  }
  const projection = validateEnrichmentProjection(selects, refs, plan);
  if (!projection.valid) return projection;
  return validateAggregateGrain(selects, plan);
}

module.exports = { validateSqlAgainstJoinPlan };
