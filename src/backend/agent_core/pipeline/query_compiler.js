'use strict';

// Compiles a query contract into one read-only T-SQL SELECT. Every JOIN
// follows a verified many-to-one relationship away from the root table, so a
// root row is never repeated and SUM/COUNT over root columns are fan-out safe
// by construction. The output must pass the same JOIN validator and filter
// verifier as model-written SQL; a failure there is a compiler bug.
const catalogApi = require('./query_catalog');
const { dateRange } = require('../harness/request_filters');

const fail = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
const key = catalogApi.key;
const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const DATE_TYPES = new Set(['date', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset']);
const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney']);
const AGGREGATE_LABELS = { SUM: 'Tổng', AVG: 'Trung bình', COUNT: 'Số lượng', MIN: 'Nhỏ nhất', MAX: 'Lớn nhất' };
const quote = name => `[${String(name).replaceAll(']', ']]')}]`;
const text = value => `N'${String(value).replaceAll("'", "''")}'`;
const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(Date.parse(value)) ? String(value) : null;
const dmy = value => value.split('-').reverse().join('/');

function compile(contract, catalog, { question = '', previousQuestion = '' } = {}) {
  const root = catalogApi.table(catalog, contract.root);
  if (!root) throw fail('V2_ROOT_UNKNOWN', contract.root);
  const joins = [], joinAliases = new Map();
  const joinAlias = (parentAlias, relation) => {
    const id = `${parentAlias}|${relation.id}`;
    if (!joinAliases.has(id)) {
      joins.push({ alias: `t${joins.length + 1}`, parentAlias, relation, entry: catalogApi.table(catalog, relation.toTable) });
      joinAliases.set(id, joins.at(-1).alias);
    }
    return joinAliases.get(id);
  };
  // The verified many-to-one path from the root. Two paths of any length are
  // two business roles (invoice type vs customer type), never a shortest-path
  // choice: the contract must then name the foreign key with "->".
  const pathTo = target => {
    let frontier = [{ table: root.tableName, hops: [] }];
    const found = [];
    for (let depth = 0; depth < 3 && frontier.length; depth++) {
      frontier = frontier.flatMap(node => catalog.relations.filter(relation => key(relation.fromTable) === key(node.table)
        && !node.hops.some(hop => hop.id === relation.id)).map(relation => ({ table: relation.toTable, hops: [...node.hops, relation] })));
      found.push(...frontier.filter(node => key(node.table) === key(target)));
    }
    if (found.length === 1) return found[0].hops;
    if (found.length > 1) throw fail('V2_LOOKUP_AMBIGUOUS', `${target} via ${found.map(node => node.hops.map(hop => hop.pairs[0].source).join('->')).join(' | ')}`);
    throw fail('V2_LOOKUP_UNREACHABLE', target);
  };
  const resolve = (ref, { display = false } = {}) => {
    const [head, ...rest] = String(ref || '').split('->').map(part => part.trim());
    // A bare column name refers to the root table.
    const dot = head.lastIndexOf('.');
    if (!head || dot === 0) throw fail('V2_REF_INVALID', ref);
    let entry = dot < 0 ? root : catalogApi.table(catalog, head.slice(0, dot));
    if (!entry) throw fail('V2_TABLE_UNKNOWN', ref);
    let alias = 't0', name = dot < 0 ? head : head.slice(dot + 1), lastHop = null;
    if (key(entry.tableName) !== key(root.tableName)) for (const hop of pathTo(entry.tableName)) alias = joinAlias(alias, hop);
    for (const next of rest) {
      const fk = catalogApi.foreignKey(catalog, entry.tableName, name);
      if (!fk) throw fail('V2_LOOKUP_UNKNOWN', `${entry.tableName}.${name}`);
      alias = joinAlias(alias, fk); entry = catalogApi.table(catalog, fk.toTable); name = next; lastHop = fk;
    }
    let column = entry.columns.get(key(name));
    if (!column) throw fail('V2_COLUMN_UNKNOWN', ref);
    // A lookup's display column is named by its business role ("Phòng ban"), not "Tên".
    let role = lastHop?.display && key(lastHop.display) === key(column.name) ? lastHop.role : '';
    // Show a mapped foreign key through its configured display column.
    const fk = display && catalogApi.foreignKey(catalog, entry.tableName, column.name);
    if (fk?.display) {
      alias = joinAlias(alias, fk); entry = catalogApi.table(catalog, fk.toTable);
      column = entry.columns.get(key(fk.display)); role = fk.role;
    }
    return { alias, entry, column, expr: `${alias}.${quote(column.name)}`, viaLookup: alias !== 't0', label: role || column.label || column.name };
  };

  const used = new Set();
  const label = (preferred, entry) => {
    let value = preferred;
    if (/^[A-Za-z0-9_]+$/.test(String(value))) value = entry.columns.get(key(value))?.label || value;
    if (used.has(fold(value))) value = `${preferred} (${entry.label || entry.tableName})`;
    for (let i = 2; used.has(fold(value)); i++) value = `${preferred} ${i}`;
    used.add(fold(value));
    return value;
  };

  // Filters: grounded in the question (or the previous one for carried scope).
  const where = [], requestFilters = [], scope = [], textFilters = [];
  for (const [filterIndex, filter] of (contract.filters || []).entries()) {
    const ref = resolve(filter.ref);
    const operator = filter.operator || 'eq';
    const source = fold(filter.inherited ? `${question}\n${previousQuestion}` : question);
    const evidence = fold(filter.evidence);
    if (!evidence || !source.includes(evidence)) throw fail('V2_FILTER_UNGROUNDED', `${filter.ref} "${filter.evidence}"`);
    const type = ref.column.type, name = ref.label;
    const identity = { table: ref.entry.tableName, column: ref.column.name, schemaName: ref.entry.schemaName };
    const value = filter.value;
    if (DATE_TYPES.has(type) && ['eq', 'period'].includes(operator)) {
      const range = dateRange(value);
      if (!range) throw fail('V2_PERIOD_INVALID', String(value));
      where.push(`${ref.expr} >= '${range.from}' AND ${ref.expr} < '${range.to}'`);
      requestFilters.push({ ...identity, value, ...range, dateOnly: type === 'date' });
      scope.push(`${name}: ${dmy(range.from)} – trước ${dmy(range.to)}`);
      continue;
    }
    if (['gte', 'gt', 'lt', 'lte'].includes(operator)) {
      const sign = { gte: '>=', gt: '>', lt: '<', lte: '<=' }[operator];
      if (DATE_TYPES.has(type)) {
        if (!isoDate(value)) throw fail('V2_DATE_INVALID', String(value));
        where.push(`${ref.expr} ${sign} '${value}'`); scope.push(`${name} ${sign} ${dmy(value)}`);
      } else {
        if (!NUMERIC_TYPES.has(type) || !Number.isFinite(Number(value))) throw fail('V2_FILTER_TYPE', ref.column.name);
        where.push(`${ref.expr} ${sign} ${Number(value)}`); scope.push(`${name} ${sign} ${value}`);
      }
      continue;
    }
    if (operator === 'isNull' || operator === 'notNull') {
      where.push(`${ref.expr} IS ${operator === 'isNull' ? '' : 'NOT '}NULL`); scope.push(`${name} ${operator === 'isNull' ? 'trống' : 'có giá trị'}`);
      continue;
    }
    const values = operator === 'in' ? filter.values || [] : [value];
    if (!values.length || values.some(item => item === undefined || item === null || item === '')) throw fail('V2_FILTER_VALUE_REQUIRED', filter.ref);
    // A code or name never matches a numeric ID column: that needs a lookup.
    if (NUMERIC_TYPES.has(type) && values.some(item => !Number.isFinite(Number(item)))) throw fail('V2_FILTER_TYPE', `${ref.column.name} = ${values.join(',')}`);
    const asked = filter.resolvedFrom !== undefined ? [filter.resolvedFrom] : values;
    if (asked.some(item => !source.includes(fold(item)) && !evidence.includes(fold(item)))) throw fail('V2_FILTER_UNGROUNDED', `${filter.ref} = ${values.join(',')}`);
    if (operator === 'eq' && !NUMERIC_TYPES.has(type)) textFilters.push({ index: filterIndex, ...identity });
    const sqlValues = values.map(item => NUMERIC_TYPES.has(type) ? String(Number(item)) : text(item));
    if (operator === 'contains') {
      const escaped = String(value).replace(/[%_[]/g, char => `[${char}]`);
      where.push(`${ref.expr} LIKE ${text(`%${escaped}%`)}`); scope.push(`${name} chứa "${value}"`);
    } else if (operator === 'in') {
      where.push(`${ref.expr} IN (${sqlValues.join(', ')})`); scope.push(`${name}: ${values.join(', ')}`);
    } else if (operator === 'eq') {
      where.push(`${ref.expr} = ${sqlValues[0]}`); scope.push(`${name} = ${value}`);
      requestFilters.push({ ...identity, value: NUMERIC_TYPES.has(type) ? Number(value) : value });
    } else throw fail('V2_OPERATOR_UNSUPPORTED', operator);
  }

  const select = [], groupBy = [], outputs = [];
  const operation = contract.operation === 'aggregate' ? 'aggregate' : 'list';
  if (operation === 'aggregate') {
    for (const group of contract.groupBy || []) {
      const ref = resolve(group.ref, { display: !group.grain });
      let expression = ref.expr, name = ref.label;
      if (group.grain) {
        if (!DATE_TYPES.has(ref.column.type)) throw fail('V2_TIME_NOT_DATE', group.ref);
        expression = group.grain === 'year' ? `YEAR(${ref.expr})` : group.grain === 'day' ? `CAST(${ref.expr} AS DATE)` : `DATEFROMPARTS(YEAR(${ref.expr}), MONTH(${ref.expr}), 1)`;
        name = { year: 'Năm', day: 'Ngày', month: 'Tháng' }[group.grain] || 'Tháng';
      }
      const alias = label(name, ref.entry);
      select.push(`${expression} AS ${quote(alias)}`); groupBy.push(expression); outputs.push({ alias, kind: 'dimension' });
    }
    if (!contract.measures?.length) throw fail('V2_MEASURE_REQUIRED');
    for (const measure of contract.measures) {
      const aggregation = String(measure.aggregation || '').toUpperCase();
      if (!AGGREGATE_LABELS[aggregation]) throw fail('V2_AGGREGATION_INVALID', aggregation);
      if (measure.ref === '*') {
        if (aggregation !== 'COUNT') throw fail('V2_AGGREGATION_INVALID', `${aggregation}(*)`);
        const alias = label(measure.label && !/^[A-Za-z0-9_]+$/.test(measure.label) ? measure.label : 'Số bản ghi', root);
        select.push(`COUNT(*) AS ${quote(alias)}`); outputs.push({ alias, kind: 'measure' });
        continue;
      }
      const ref = resolve(measure.ref);
      // Values of a lookup repeat for every root row: only MIN/MAX/COUNT DISTINCT are meaningful there.
      if (ref.viaLookup && !['MIN', 'MAX'].includes(aggregation) && !(aggregation === 'COUNT' && measure.distinct)) throw fail('V2_MEASURE_GRAIN', measure.ref);
      if (['SUM', 'AVG'].includes(aggregation) && !NUMERIC_TYPES.has(ref.column.type)) throw fail('V2_MEASURE_NOT_NUMERIC', measure.ref);
      const named = measure.label && !/^[A-Za-z0-9_]+$/.test(measure.label) ? measure.label : null;
      const alias = label(named || `${AGGREGATE_LABELS[aggregation]} ${ref.label}`, ref.entry);
      select.push(`${aggregation}(${aggregation === 'COUNT' && measure.distinct ? 'DISTINCT ' : ''}${ref.expr}) AS ${quote(alias)}`);
      outputs.push({ alias, kind: 'measure' });
    }
  } else {
    // Default list: configured summary fields plus the business date and the
    // main labeled amount, so "liệt kê hóa đơn" shows when and how much.
    const money = (root.money || []).map(name => root.columns.get(key(name))).filter(item => item?.label);
    const amount = money.find(item => /final|sau thuế/i.test(`${item.name} ${item.label}`)) || money[0];
    const chosen = contract.fields?.length ? [...contract.fields] : [];
    // A transaction list without any amount column gets the main amount.
    if (chosen.length && amount && !chosen.some(field => (root.money || []).some(name => key(String(field).split('->').pop().split('.').pop()) === key(name))))
      chosen.push(`${root.tableName}.${amount.name}`);
    const fields = chosen.length ? chosen
      : [...new Set([...root.defaults, root.dateColumn, amount?.name].filter(Boolean))].map(name => `${root.tableName}.${name}`);
    if (!fields.length) throw fail('V2_FIELDS_REQUIRED');
    const seen = new Set();
    for (const field of fields) {
      const ref = resolve(field, { display: true });
      if (seen.has(ref.expr)) continue;
      seen.add(ref.expr);
      const alias = label(ref.label, ref.entry);
      select.push(`${ref.expr} AS ${quote(alias)}`); outputs.push({ alias, kind: 'field' });
    }
  }

  let orderBy = '';
  if (contract.sort?.by) {
    const direction = String(contract.sort.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const measureIndex = /^measure:(\d+)$/.exec(contract.sort.by)?.[1];
    if (measureIndex !== undefined) {
      const target = outputs.filter(item => item.kind === 'measure')[Number(measureIndex)];
      if (!target) throw fail('V2_SORT_INVALID', contract.sort.by);
      orderBy = `${quote(target.alias)} ${direction}`;
    } else {
      const ref = resolve(contract.sort.by);
      if (operation === 'aggregate' && !groupBy.includes(ref.expr)) throw fail('V2_SORT_INVALID', contract.sort.by);
      orderBy = `${ref.expr} ${direction}`;
    }
  } else if (groupBy.length) orderBy = groupBy.join(', ');
  const limit = Number.isInteger(contract.limit) && contract.limit > 0 ? Math.min(contract.limit, 1000) : null;
  const top = limit || (operation === 'list' || groupBy.length ? 100 : null);

  const from = [`FROM ${quote(root.schemaName)}.${quote(root.tableName)} t0`,
    ...joins.map(join => `LEFT JOIN ${quote(join.entry.schemaName)}.${quote(join.entry.tableName)} ${join.alias} ON `
      + join.relation.pairs.map(pair => `${join.alias}.${quote(pair.target)} = ${join.parentAlias}.${quote(pair.source)}`).join(' AND '))];
  const sql = `SELECT ${top ? `TOP ${top} ` : ''}${select.join(', ')} ${from.join(' ')}`
    + `${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : ''}${orderBy ? ` ORDER BY ${orderBy}` : ''}`;

  const entryFor = alias => alias === 't0' ? root : joins.find(join => join.alias === alias).entry;
  const joinPlan = { outcome: 'ready', purpose: 'join', dbSourceId: catalog.dbSourceId, rootTableId: root.tableId,
    tableRefs: ['t0', ...joins.map(join => join.alias)].map(alias => ({ tableRefId: alias, alias, tableId: entryFor(alias).tableId,
      tableName: entryFor(alias).tableName, schemaName: entryFor(alias).schemaName })),
    edges: joins.map(join => ({ relationshipId: join.relation.id, revision: join.relation.revision, fromTableRefId: join.parentAlias, toTableRefId: join.alias,
      fromTableId: entryFor(join.parentAlias).tableId, toTableId: join.entry.tableId, cardinality: 'many-to-one', joinType: 'LEFT',
      columnPairs: join.relation.pairs.map(pair => ({ sourceColumn: pair.source, targetColumn: pair.target })) })) };

  // Self-check with the shared validators; these must agree with the compiler.
  const joinCheck = require('../../services/sql_join_validator').validateSqlAgainstJoinPlan(sql, joinPlan);
  if (!joinCheck.valid) throw fail('V2_SELF_CHECK_JOIN', `${joinCheck.code} ${joinCheck.error}`);
  const singleUse = requestFilters.filter(item => joinPlan.tableRefs.filter(ref => key(ref.tableName) === key(item.table)).length === 1);
  if (!require('../harness/schema_scope').matchesScope(sql, singleUse)) throw fail('V2_SELF_CHECK_SCOPE');
  return { sql, joinPlan, requestFilters, textFilters, outputs, scope, operation, root: root.tableName, analysis: contract.analysis || 'none' };
}

module.exports = { compile };
