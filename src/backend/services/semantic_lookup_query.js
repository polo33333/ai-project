'use strict';
const { Parser } = require('node-sql-parser');
const key = value => String(value || '').toLowerCase();
const fail = () => Object.assign(new Error('SEMANTIC_JOIN_REQUIRED: use verified SQL JOINs for mapped fields; do not answer without executing the required query.'), { code: 'SEMANTIC_JOIN_REQUIRED' });
function compile(input, tables, scope, contract, time, joinPlan) {
  const mapped = contract?.attributes?.filter(attribute => attribute.mappedSource) || [];
  if (!mapped.length) return require('./semantic_query').compile(input, tables, scope, contract, time);
  if (!['list', 'detail', 'compare'].includes(input.operation) || joinPlan?.outcome !== 'ready') throw fail();
  const root = joinPlan.tableRefs.find(ref => key(ref.tableName) === key(input.table));
  if (!root) throw fail();
  const bindings = mapped.map(attribute => {
    const matches = joinPlan.edges.flatMap(edge => {
      const from = joinPlan.tableRefs.find(ref => ref.tableRefId === edge.fromTableRefId || !edge.fromTableRefId && ref.tableId === edge.fromTableId);
      const to = joinPlan.tableRefs.find(ref => ref.tableRefId === edge.toTableRefId || !edge.toTableRefId && ref.tableId === edge.toTableId);
      const target = tables.find(table => key(table.tableName) === key(to?.tableName) && key(table.schemaName || 'dbo') === key(to?.schemaName || 'dbo'));
      return from === root && to && !edge.reversed && ['many-to-one', 'one-to-one'].includes(edge.cardinality)
        && target?.columns.some(column => column.isVisible !== false && key(column.columnName) === key(edge.displayColumn))
        && key(to.tableName) === key(attribute.mappedSource.table) && key(edge.displayColumn) === key(attribute.mappedSource.column)
        && [edge.businessRole, edge.displayColumn, ...(edge.columnPairs || []).map(pair => pair.sourceColumn)].some(name => [attribute.name, attribute.requestedAs].some(value => key(value) === key(name)))
        ? [{ attribute, edge, from, to }] : [];
    });
    if (matches.length !== 1) throw fail();
    return matches[0];
  });
  const table = tables.find(table => key(table.tableName) === key(input.table));
  const allowed = new Set((table?.columns || []).filter(column => column.isVisible !== false).map(column => key(column.columnName)));
  if ((input.fields || []).some(field => !allowed.has(key(field)) && !mapped.some(attribute => [attribute.name, attribute.requestedAs].some(name => key(name) === key(field))))) throw fail();
  const fields = (input.fields || []).filter(field => allowed.has(key(field)));
  const rootContract = { ...contract, attributes: contract.attributes.filter(attribute => !attribute.mappedSource) };
  const base = require('./semantic_query').compile({ ...input, fields }, tables, scope, rootContract, time);
  const parser = new Parser(), ast = parser.astify(base.sql, { database: 'TransactSQL' });
  const qualify = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'column_ref' && !node.table) node.table = root.alias;
    Object.values(node).forEach(value => Array.isArray(value) ? value.forEach(qualify) : qualify(value));
  };
  qualify(ast);
  const edges = [...new Set(bindings.map(binding => binding.edge))];
  const quote = value => '[' + String(value).replaceAll(']', ']]') + ']';
  const from = `${quote(root.schemaName || 'dbo')}.${quote(root.tableName)} ${root.alias}`;
  const joins = edges.map(edge => {
    const binding = bindings.find(binding => binding.edge === edge);
    return `LEFT JOIN ${quote(binding.to.schemaName || 'dbo')}.${quote(binding.to.tableName)} ${binding.to.alias} ON `
      + edge.columnPairs.map(pair => `${root.alias}.${quote(pair.sourceColumn)} = ${binding.to.alias}.${quote(pair.targetColumn)}`).join(' AND ');
  });
  ast.from = parser.astify(`SELECT ${root.alias}.* FROM ${from} ${joins.join(' ')}`, { database: 'TransactSQL' }).from;
  const replaced = new Set(edges.flatMap(edge => edge.columnPairs.map(pair => key(pair.sourceColumn))));
  ast.columns = ast.columns.filter(column => !(column.expr?.type === 'column_ref' && replaced.has(key(column.expr.column))));
  for (const binding of bindings) ast.columns.push({ expr: { type: 'column_ref', table: binding.to.alias, column: binding.edge.displayColumn }, as: binding.attribute.name });
  return { ...base, sql: parser.sqlify(ast, { database: 'TransactSQL' }), joined: true };
}
module.exports = { compile };
