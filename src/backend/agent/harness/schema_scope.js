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
    // `col IN (v)` with a single value is the same predicate as `col = v`.
    const pairs = predicate => predicate?.operator === '=' ? [[predicate.left, predicate.right], [predicate.right, predicate.left]]
      : predicate?.operator === 'IN' && predicate.right?.type === 'expr_list' && predicate.right.value?.length === 1
        ? [[predicate.left, predicate.right.value[0]]] : [];
    const sameColumn = (column, filter) => {
      if (column?.type !== 'column_ref' || key(column.column) !== key(filter.column)) return false;
      const sources = (statement.from || []).filter(source => !column.table || key(column.table) === key(source.as || source.table));
      // Same-named tables in different schemas are different identities.
      return sources.length === 1 && key(sources[0].table) === key(filter.table)
        && (!filter.schemaName || key(sources[0].db || 'dbo') === key(filter.schemaName));
    };
    return filters.every(filter => filter.from && filter.to
      ? rangeMatches(conjuncts(statement.where), filter, column => sameColumn(column, filter))
      : conjuncts(statement.where).some(predicate => pairs(predicate).some(([column, literal]) => sameColumn(column, filter)
        && ['number', 'single_quote_string', 'var_string', 'string', 'bool'].includes(literal?.type) && literal.value === filter.value)));
  } catch { return false; }
}

// A period filter holds only when the WHERE conjuncts restrict the column to
// exactly [from, to): `>= from AND < to`, BETWEEN / <= last day on a DATE
// column (or 23:59:59 on datetime), or YEAR()/MONTH()/DAY() equalities.
// Extra bounds narrow the effective range and fail, as does any widening.
const DAY = 86400000;
function literalDate(node) {
  if (node?.type === 'cast') return literalDate(node.expr);
  const name = String(node?.name?.name?.[0]?.value || '').toUpperCase();
  if (node?.type === 'function' && name === 'DATEFROMPARTS') {
    const [y, m, d] = (node.args?.value || []).map(item => item?.type === 'number' ? item.value : NaN);
    const time = Date.UTC(y, m - 1, d);
    return Number.isFinite(time) ? { time, midnight: true, endOfDay: false } : null;
  }
  if (!['single_quote_string', 'var_string', 'string'].includes(node?.type)) return null;
  const match = String(node.value).trim().match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (!match) return null;
  const clock = [match[4], match[5], match[6]].map(part => Number(part || 0));
  return { time: Date.UTC(+match[1], +match[2] - 1, +match[3]), midnight: clock.every(part => part === 0),
    endOfDay: clock[0] === 23 && clock[1] === 59 && clock[2] === 59 };
}
function rangeMatches(predicates, filter, isColumn) {
  const from = Date.parse(filter.from), to = Date.parse(filter.to);
  const flip = { '>=': '<=', '<=': '>=', '>': '<', '<': '>', '=': '=' };
  const inclusiveUpper = value => !value ? null : value.endOfDay || (filter.dateOnly && value.midnight) ? value.time + DAY : null;
  let lower = -Infinity, upper = Infinity;
  const parts = {};
  for (const predicate of predicates) {
    if (predicate?.type !== 'binary_expr') continue;
    if (predicate.operator === 'BETWEEN' && isColumn(predicate.left)) {
      const [start, end] = (predicate.right?.value || []).map(literalDate);
      if (!start?.midnight || inclusiveUpper(end) === null) return false;
      lower = Math.max(lower, start.time); upper = Math.min(upper, inclusiveUpper(end));
      continue;
    }
    let [left, operator, right] = [predicate.left, predicate.operator, predicate.right];
    if (!isColumn(left) && isColumn(right)) [left, operator, right] = [right, flip[operator], left];
    if (isColumn(left)) {
      const value = literalDate(right);
      if (!value) continue;
      if (operator === '>=' && value.midnight) lower = Math.max(lower, value.time);
      else if (operator === '<' && value.midnight) upper = Math.min(upper, value.time);
      else if (operator === '<=' && inclusiveUpper(value) !== null) upper = Math.min(upper, inclusiveUpper(value));
      else return false;
      continue;
    }
    const part = String(left?.name?.name?.[0]?.value || '').toUpperCase();
    if (operator === '=' && left?.type === 'function' && ['YEAR', 'MONTH', 'DAY'].includes(part)
      && isColumn(left.args?.value?.[0]) && right?.type === 'number') parts[part] = right.value;
  }
  if (lower === from && upper === to) return true;
  const start = new Date(from), last = new Date(to - DAY);
  const expected = to - from === DAY ? ['YEAR', 'MONTH', 'DAY'] : start.getUTCMonth() === last.getUTCMonth() ? ['YEAR', 'MONTH'] : ['YEAR'];
  const actual = { YEAR: start.getUTCFullYear(), MONTH: start.getUTCMonth() + 1, DAY: start.getUTCDate() };
  return lower === -Infinity && upper === Infinity && Object.keys(parts).length === expected.length
    && expected.every(name => parts[name] === actual[name]);
}

module.exports = { decodeScope, matchesScope };
