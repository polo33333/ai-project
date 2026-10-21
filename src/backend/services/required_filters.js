'use strict';

const { Parser } = require('node-sql-parser');
const schema = { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
  required: ['column', 'operator'], properties: {
    column: { type: 'string', minLength: 1, maxLength: 128 },
    operator: { enum: ['eq', 'is_null', 'is_not_null'] },
    value: { type: ['string', 'number', 'boolean'], maxLength: 500 }
  } } };
const valid = new (require('ajv'))({ strict: false }).compile(schema);
const fail = (code, message) => Object.assign(new Error(message || code), { code, statusCode: 400 });
function validate(filters, table) {
  if (!valid(filters)) throw fail('REQUIRED_FILTER_INVALID', 'Bộ lọc bắt buộc không đúng cấu trúc.');
  const seen = new Set();
  for (const filter of filters) {
    const column = table.columns?.find(c => c.columnName === filter.column && c.isVisible !== false);
    if (!column) throw fail('REQUIRED_FILTER_COLUMN_UNAVAILABLE', `Cột lọc ${filter.column} phải tồn tại và được bật.`);
    if (seen.has(filter.column)) throw fail('REQUIRED_FILTER_DUPLICATE', 'Mỗi cột chỉ khai báo một điều kiện bắt buộc.');
    seen.add(filter.column);
    if ((filter.operator === 'eq') !== Object.hasOwn(filter, 'value')) throw fail('REQUIRED_FILTER_VALUE_INVALID');
    if (filter.operator === 'eq') {
      const type = require('./schema_quality').typeOf(column);
      if (require('./schema_quality').numericTypes.has(type) && (typeof filter.value !== 'number' || !Number.isFinite(filter.value))) throw fail('REQUIRED_FILTER_TYPE');
      if (type === 'bit' && ![true, false, 0, 1].includes(filter.value)) throw fail('REQUIRED_FILTER_TYPE');
      if (!require('./schema_quality').numericTypes.has(type) && type !== 'bit' && typeof filter.value !== 'string') throw fail('REQUIRED_FILTER_TYPE');
    }
  }
  return structuredClone(filters);
}
const quote = name => '[' + String(name).replaceAll(']', ']]') + ']';
function predicate(filter) {
  if (filter.operator === 'is_null') return `${quote(filter.column)} IS NULL`;
  if (filter.operator === 'is_not_null') return `${quote(filter.column)} IS NOT NULL`;
  const value = typeof filter.value === 'string' ? "N'" + filter.value.replaceAll("'", "''") + "'" : typeof filter.value === 'boolean' ? (filter.value ? '1' : '0') : String(filter.value);
  return `${quote(filter.column)} = ${value}`;
}

// Enforce the catalog rules at the common SQL execution boundary. This first
// version intentionally accepts a provable, single-table SELECT only whenever
// the source has required filters; complex SQL must not silently bypass them.
function enforce(sql, tables) {
  const configured = tables.filter(t => t.requiredFilters !== undefined);
  for (const table of configured) validate(table.requiredFilters, table);
  if (!configured.some(t => t.requiredFilters.length)) return sql;
  const parser = new Parser(), options = { database: 'TransactSQL' };
  let ast;
  try { ast = parser.astify(sql, options); } catch { throw fail('REQUIRED_FILTER_SQL_UNSUPPORTED'); }
  if (Array.isArray(ast) || ast.type !== 'select' || ast.with?.length || ast._next || ast.from?.length !== 1 || !ast.from[0].table)
    throw fail('REQUIRED_FILTER_SQL_UNSUPPORTED', 'Nguồn có bộ lọc bắt buộc: hiện chỉ hỗ trợ SELECT một bảng, không có CTE, UNION hoặc JOIN.');
  const containsNested = node => node && typeof node === 'object' && Object.values(node).some(value => value && typeof value === 'object' && (value.type === 'select' || containsNested(value)));
  if (containsNested(ast)) throw fail('REQUIRED_FILTER_SQL_UNSUPPORTED');
  const ref = ast.from[0], key = value => String(value || '').toLowerCase();
  const matches = tables.filter(t => key(t.tableName) === key(ref.table) && key(t.schemaName || 'dbo') === key(ref.db || 'dbo'));
  if (matches.length !== 1 || ref.schema || ref.server || ref.temporal_table || ref.table_hint) throw fail('REQUIRED_FILTER_TABLE_UNAVAILABLE');
  const table = matches[0], filters = validate(table.requiredFilters || [], table);
  if (!filters.length) return sql;
  const conjuncts = node => node?.type === 'binary_expr' && node.operator === 'AND' ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node];
  const normalize = node => {
    const copy = structuredClone(node);
    if (copy && typeof copy === 'object') {
      delete copy.parentheses;
      if (copy.type === 'column_ref') {
        if (copy.table && key(copy.table) !== key(ref.as || ref.table)) return null;
        copy.table = null;
      }
      for (const name of Object.keys(copy)) if (copy[name] && typeof copy[name] === 'object') copy[name] = normalize(copy[name]);
    }
    return copy;
  };
  const conditions = conjuncts(ast.where).map(node => JSON.stringify(normalize(node)));
  for (const filter of filters) {
    const expected = parser.astify(`SELECT * FROM ${quote(table.tableName)} WHERE ${predicate(filter)}`, options).where;
    if (!conditions.includes(JSON.stringify(normalize(expected)))) throw fail('REQUIRED_FILTER_MISSING', `Truy vấn thiếu bộ lọc bắt buộc của bảng ${table.tableName}. Hãy dùng truy vấn có cấu trúc hoặc bổ sung đúng điều kiện đã cấu hình.`);
  }
  return sql;
}
module.exports = { schema, validate, predicate, enforce };
