'use strict';

const validate = new (require('ajv'))({ allowUnionTypes: true }).compile({ type: 'object', additionalProperties: false, required: ['filters'], properties: {
  filters: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['table', 'column', 'value', 'evidence'], properties: {
    table: { type: 'string' }, column: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] }, evidence: { type: 'string', minLength: 1 }
  } } }
} });

function decodeScope(text, tables) {
  let json = String(text || '').trim();
  if (json.startsWith('```') && json.endsWith('```')) json = json.split('\n').slice(1, -1).join('\n');
  const scope = JSON.parse(json);
  if (!validate(scope)) throw new Error('SCHEMA_SCOPE_INVALID');
  for (const filter of scope.filters) {
    const column = tables.find(table => table.tableName === filter.table)?.columns.find(column => column.name === filter.column);
    if (!column?.description?.includes(filter.evidence) || !filter.evidence.includes(String(filter.value))) throw new Error('SCHEMA_SCOPE_UNGROUNDED');
    if (typeof filter.value === 'string' && ['INT', 'SMALLINT', 'TINYINT', 'BIGINT', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC'].includes(String(column.type).toUpperCase()) && filter.value.trim() && Number.isFinite(Number(filter.value))) filter.value = Number(filter.value);
  }
  return scope;
}

function matchesScope(sql, filters = []) {
  if (!filters.length) return true;
  try {
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    const statement = Array.isArray(parsed) ? parsed[0] : parsed;
    const key = value => String(value || '').toLowerCase();
    const conjuncts = node => node?.type === 'binary_expr' && node.operator === 'AND' ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node];
    return filters.every(filter => conjuncts(statement.where).some(predicate => {
      if (predicate?.operator !== '=') return false;
      return [[predicate.left, predicate.right], [predicate.right, predicate.left]].some(([column, literal]) => {
        if (column?.type !== 'column_ref' || key(column.column) !== key(filter.column) || !['number', 'single_quote_string', 'bool'].includes(literal?.type) || literal.value !== filter.value) return false;
        const sources = (statement.from || []).filter(source => !column.table || key(column.table) === key(source.as || source.table));
        return sources.length === 1 && key(sources[0].table) === key(filter.table);
      });
    }));
  } catch { return false; }
}

module.exports = { decodeScope, matchesScope };
