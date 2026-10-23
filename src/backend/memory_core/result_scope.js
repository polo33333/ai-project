'use strict';
const { Parser } = require('node-sql-parser');
const key = value => String(value || '').toLowerCase();

// Store request structure, not SQL text or an executable plan. Unsupported
// shapes fail closed when a later turn asks to preserve this exact dataset.
function describe(sql) {
  try {
    const ast = new Parser().astify(sql, { database: 'TransactSQL' });
    if (Array.isArray(ast) || ast.with?.length || ast._next || !ast.from?.length || ast.from.some(s => !s.table || s.expr)) return null;
    const sources = ast.from.map(s => ({ alias: key(s.as || s.table), table: key(`${s.db || 'dbo'}.${s.table}`) }));
    if (new Set(sources.map(s => s.table)).size !== sources.length) return null;
    const canonical = node => {
      if (Array.isArray(node)) return node.map(canonical);
      if (!node || typeof node !== 'object') return node;
      if (node.type === 'select') throw new Error('Nested scope');
      if (['single_quote_string', 'var_string'].includes(node.type)) return { type: 'var_string', value: node.value };
      const result = {};
      for (const name of Object.keys(node).sort().filter(n => n !== 'parentheses')) {
        result[name] = node.type === 'column_ref' && name === 'table'
          ? sources.find(s => s.alias === key(node[name]))?.table || (sources.length === 1 ? sources[0].table : key(node[name]))
          : node.type === 'column_ref' && name === 'column' ? key(node[name]) : canonical(node[name]);
      }
      if (node.type === 'binary_expr' && node.operator === '=' && JSON.stringify(result.left) > JSON.stringify(result.right)) {
        [result.left, result.right] = [result.right, result.left];
      }
      return result;
    };
    const conjuncts = node => !node ? [] : node.type === 'binary_expr' && node.operator === 'AND'
      ? [...conjuncts(node.left), ...conjuncts(node.right)] : [JSON.stringify(canonical(node))];
    return { root: sources[0].table, tables: sources.map(s => s.table),
      outputs: ast.columns.filter(column => column.expr?.type === 'column_ref' && column.expr.column !== '*').map(column => ({
        name: column.as || column.expr.column, column: key(column.expr.column),
        table: sources.find(source => source.alias === key(column.expr.table))?.table || (sources.length === 1 ? sources[0].table : null)
      })),
      predicates: conjuncts(ast.where).sort(), joins: ast.from.slice(1).map((s, i) => ({ table: sources[i + 1].table,
        kind: key(s.join), predicates: conjuncts(s.on).sort() })),
      grouping: JSON.stringify(canonical(ast.groupby || null)), having: JSON.stringify(canonical(ast.having || null)) };
  } catch { return null; }
}

function assess(call, reference) {
  if (!reference) return [];
  const fail = ['FOLLOWUP_SCOPE_MISMATCH'];
  const actualSource = call.result?.dbSourceId || call.result?.sourceId;
  if (reference.dbSourceId && actualSource && actualSource !== reference.dbSourceId) return ['SQL_SOURCE_MISMATCH'];
  const actual = describe(call.result?.sql || call.args?.sql || '');
  if (!actual || !reference.datasets?.length) return ['FOLLOWUP_SCOPE_UNAVAILABLE'];
  // PostgreSQL JSONB reorders object keys. Scope equality must survive storage.
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(name => [name, stable(value[name])])) : value;
  const equal = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
  const dataset = reference.datasets.find(d => d.scope && actual.root === d.scope.root
    && equal(actual.predicates, d.scope.predicates) && equal(actual.grouping, d.scope.grouping) && equal(actual.having, d.scope.having)
    && d.scope.joins.every(join => actual.joins.some(next => equal(next, join)))
    && actual.joins.filter(join => !d.scope.tables.includes(join.table)).every(join => join.kind === 'left join'));
  if (!dataset) return fail;
  if (reference.columns?.length) {
    try {
      const ast = new Parser().astify(call.result?.sql || call.args?.sql || '', { database: 'TransactSQL' });
      const names = (ast.columns || []).flatMap(column => [column.as, column.expr?.type === 'column_ref' ? column.expr.column : null]).filter(Boolean).map(key);
      if (reference.columns.some(column => ![column, reference.displayNames?.[column]].filter(Boolean).some(name => names.includes(key(name))))) return ['FOLLOWUP_FIELDS_MISSING'];
    } catch { return ['FOLLOWUP_SCOPE_UNAVAILABLE']; }
  }
  // Complete small result sets can additionally prove row identity and fanout.
  if (dataset.identityComplete) {
    const columns = reference.identityColumns || [];
    const rows = call.result?.rows;
    if (!Array.isArray(rows)) return fail;
    const values = rows.map(row => columns.map(column => {
      const aliases = [column, reference.displayNames?.[column], call.result?.displayNames?.[column]].filter(Boolean).map(key);
      const names = Object.keys(row).filter(name => aliases.includes(key(name)));
      return names.length === 1 ? row[names[0]] : undefined;
    }));
    const expected = dataset.entityKeys.map(row => JSON.stringify(columns.map(column => row[column]))).sort();
    if (values.some(row => row.some(value => value === undefined)) || !equal(values.map(row => JSON.stringify(row)).sort(), expected)) return fail;
  }
  return [];
}
function project(sql, reference, allowedRootColumns = [], requestedAttributes = [], contract = null) {
  const parsed = new Parser().astify(sql, { database: 'TransactSQL' });
  // A model may flatten independent groups with UNION. Use the first SELECT
  // only as a projection template; restore every verified group below.
  delete parsed._next;
  delete parsed.set_op;
  const current = describe(new Parser().sqlify(parsed, { database: 'TransactSQL' }));
  if (!current || !reference.datasets?.every(d => d.scope?.root === current.root)) throw new Error('FOLLOWUP_SCOPE_UNAVAILABLE');
  const aliases = new Map(parsed.from.map(s => [key(`${s.db || 'dbo'}.${s.table}`), s.as || s.table]));
  for (const column of parsed.columns || []) {
    if (column.expr?.type !== 'column_ref') continue;
    const source = parsed.from.find(table => key(table.as || table.table) === key(column.expr.table));
    const mapped = (contract?.attributes || []).filter(attribute => attribute.mappedSource
      && key(attribute.mappedSource.table) === key(source?.table) && key(attribute.mappedSource.column) === key(column.expr.column));
    if (mapped.length === 1) column.as = mapped[0].name;
    const previous = reference.datasets[0].scope.outputs?.filter(output => output.table === key(`${source?.db || 'dbo'}.${source?.table}`)
      && output.column === key(column.expr.column));
    if (mapped.length !== 1 && previous?.length === 1 && reference.columns?.includes(previous[0].name)) column.as = previous[0].name;
  }
  const restore = node => {
    if (Array.isArray(node)) return node.map(restore);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([name, value]) => [name,
      node.type === 'column_ref' && name === 'table' ? aliases.get(value) || (() => { throw new Error('FOLLOWUP_SCOPE_UNAVAILABLE'); })() : restore(value)]));
  };
  return reference.datasets.map(dataset => {
    const ast = structuredClone(parsed);
    const requested = [...(reference.columns || []), ...requestedAttributes].map(key);
    ast.columns = ast.columns.filter(column => !['single_quote_string', 'var_string', 'case'].includes(column.expr?.type) || requested.includes(key(column.as)));
    const replacedIds = (contract?.attributes || []).filter(attribute => attribute.mappedSource && attribute.requestedAs
      && !reference.identityColumns?.some(column => key(column) === key(attribute.requestedAs))
      && ast.columns.some(column => key(column.as) === key(attribute.name))).map(attribute => key(attribute.requestedAs));
    ast.columns = ast.columns.filter(column => !(column.expr?.type === 'column_ref'
      && key(column.expr.table) === key(ast.from[0].as || ast.from[0].table) && replacedIds.includes(key(column.expr.column))));
    const projected = ast.columns.flatMap(column => [column.as, column.expr?.type === 'column_ref' ? column.expr.column : null]).filter(Boolean).map(key);
    for (const column of reference.columns || []) {
      const physical = allowedRootColumns.find(name => key(name) === key(column));
      if (physical && ![column, reference.displayNames?.[column]].filter(Boolean).some(name => projected.includes(key(name))))
        ast.columns.push({ expr: { type: 'column_ref', table: ast.from[0].as || ast.from[0].table, column: physical }, as: null });
    }
    const predicates = dataset.scope.predicates.map(value => restore(JSON.parse(value)));
    ast.where = predicates.reduce((left, right) => left ? { type: 'binary_expr', operator: 'AND', left, right } : right, null);
    return { label: dataset.label || 'Kết quả', sql: new Parser().sqlify(ast, { database: 'TransactSQL' }) };
  });
}
function groupIndex(sql, reference) {
  return reference.datasets.findIndex(dataset => !assess({ args: { sql }, result: {} },
    { ...reference, datasets: [{ ...dataset, identityComplete: false }] }).length);
}
module.exports = { describe, assess, project, groupIndex };
