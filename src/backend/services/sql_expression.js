'use strict';

// Shared AST helpers for evidence checks. They prove what a projected value is
// derived from; they never rewrite SQL.
const key = value => String(value ?? '').replace(/[\[\]]/g, '').toLowerCase();
const functionName = node => key(node?.name?.name?.[0]?.value ?? node?.name);
const isLiteral = node => ['number', 'single_quote_string', 'string', 'var_string', 'bool', 'null'].includes(node?.type);

// Strip wrappers that keep the business value: CAST/CONVERT, ROUND(x, n) and
// ISNULL/COALESCE(x, literal). Arithmetic, CASE and other functions change the
// value and are returned unchanged so callers treat them as a different measure.
function unwrapValuePreserving(node) {
  let current = node;
  for (;;) {
    if (current?.type === 'cast') { current = current.expr; continue; }
    if (current?.type !== 'function') return current;
    const name = functionName(current);
    const args = current.args?.value || [];
    if (name === 'convert' && args.length >= 2) { current = args[1]; continue; }
    if (name === 'round' && args.length === 2 && args[1]?.type === 'number') { current = args[0]; continue; }
    if (['isnull', 'coalesce'].includes(name) && args.length === 2 && isLiteral(args[1])) { current = args[0]; continue; }
    return current;
  }
}

function columnRefs(node, refs = []) {
  if (!node || typeof node !== 'object') return refs;
  if (node.type === 'column_ref') refs.push(node);
  else if (node.type !== 'select') (Array.isArray(node) ? node : Object.values(node)).forEach(value => columnRefs(value, refs));
  return refs;
}

// Resolve a column qualifier to the physical table of the FROM item. An alias
// wins over a same-named table, so `FROM Credits Invoices` is never Invoices.
function sourceForColumn(column, from = []) {
  const qualifier = key(column?.table);
  if (!qualifier) return from.length === 1 ? from[0] : null;
  return from.find(item => key(item.as || item.table) === qualifier) || null;
}

module.exports = { unwrapValuePreserving, columnRefs, sourceForColumn, isLiteral };
