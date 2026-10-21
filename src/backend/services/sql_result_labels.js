'use strict';
const { Parser } = require('node-sql-parser/build/transactsql');
const key = value => String(value || '').toLowerCase();

// Resolve only direct projections with proven table/column lineage. Never guess
// a lookup role from a global column name such as Name or ConstantName.
function inferDisplayNames(sql, tables = [], relationships = []) {
  try {
    const ast = new Parser().astify(sql);
    if (Array.isArray(ast) || ast.type !== 'select' || ast.with?.length || ast._next) return {};
    const refs = (ast.from || []).map(ref => {
      const matches = tables.filter(t => t.isActive !== false && !t.schemaMissing
        && key(t.tableName) === key(ref.table) && key(t.schemaName || 'dbo') === key(ref.db || 'dbo'));
      return { alias:key(ref.as || ref.table), table:matches.length === 1 ? matches[0] : null, on:ref.on };
    });
    const { mandatoryEqualityPairs } = require('./sql_join_validator');
    const pairs = refs.flatMap(ref => mandatoryEqualityPairs(ref.on).pairs);
    const labels = {}, seen = new Set();
    for (const projection of ast.columns || []) {
      const expr = projection.expr;
      if (expr?.type !== 'column_ref' || expr.column === '*') continue;
      const candidates = refs.filter(ref => ref.table && (!expr.table || ref.alias === key(expr.table))
        && ref.table.columns.some(c => key(c.columnName) === key(expr.column) && c.isVisible !== false));
      if (candidates.length !== 1) continue;
      const target = candidates[0];
      const column = target.table.columns.find(c => key(c.columnName) === key(expr.column));
      const roles = relationships.filter(r => r.status === 'verified' && r.isActive !== false
        && r.targetTableId === target.table.tableId && key(r.displayColumn) === key(column.columnName) && r.businessRole
        && r.columnPairs?.length && refs.some(source => source.table?.tableId === r.sourceTableId && source.alias !== target.alias
          && r.columnPairs.every(p => source.table.columns.some(c => key(c.columnName) === key(p.sourceColumn) && c.isVisible !== false)
            && pairs.some(q => (q.leftAlias === source.alias && q.leftColumn === key(p.sourceColumn) && q.rightAlias === target.alias && q.rightColumn === key(p.targetColumn))
              || (q.rightAlias === source.alias && q.rightColumn === key(p.sourceColumn) && q.leftAlias === target.alias && q.leftColumn === key(p.targetColumn))))));
      const roleNames = [...new Set(roles.map(r => r.businessRole))];
      const label = roleNames.length === 1 ? roleNames[0] : column.displayName;
      const output = projection.as || expr.column;
      if (seen.has(output)) { delete labels[output]; continue; }
      seen.add(output);
      if (label) labels[output] = label;
    }
    return labels;
  } catch { return {}; }
}
module.exports = { inferDisplayNames };
