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
// A filter value is grounded only as whole words of its quote: "1" is not in
// "KA0021", so an invented ID never passes as the quoted code.
const WORD = /[\p{L}\p{M}\p{N}]/u;
function mentions(quote, value) {
  const needle = fold(value);
  if (!needle) return false;
  for (let at = quote.indexOf(needle); at >= 0; at = quote.indexOf(needle, at + 1))
    if (!WORD.test(quote[at - 1] || '') && !WORD.test(quote[at + needle.length] || '')) return true;
  return false;
}

// A contract that measures only approved metrics of one table, and names no
// root, is about that table. Metrics on several tables, a raw measure, or a
// root the model did name are left as they are (null).
function metricRoot(contract, catalog) {
  if (contract.root || !contract.measures?.length) return null;
  const tables = contract.measures.map(measure => measure.metric && catalogApi.metric(catalog, measure.metric)?.table);
  if (tables.some(table => !table)) return null;
  return new Set(tables.map(key)).size === 1 ? tables[0] : null;
}

// A metric named after an aggregation ("COUNT") that is not an approved
// metric id is a raw measure: that aggregation over its ref (COUNT defaults
// to records). A different explicit aggregation leaves it ambiguous.
function rawAggregationMeasure(measure, catalog) {
  const named = String(measure?.metric || '').toUpperCase();
  if (!AGGREGATE_LABELS[named] || catalogApi.metric(catalog, measure.metric)) return measure;
  if (measure.aggregation && String(measure.aggregation).toUpperCase() !== named)
    throw fail('V2_MEASURE_INVALID', `metric ${measure.metric} is an aggregation, not an approved metric id, and differs from aggregation ${measure.aggregation}`);
  const { metric, ...raw } = measure;
  return { ...raw, aggregation: named, ref: raw.ref || (named === 'COUNT' ? '*' : raw.ref) };
}

function compile(contract, catalog, { question = '', previousQuestion = '', resultValues = new Set() } = {}) {
  if (contract.measures?.length) contract = { ...contract, measures: contract.measures.map(measure => rawAggregationMeasure(measure, catalog)) };
  const root =catalogApi.table(catalog, contract.root || metricRoot(contract, catalog));
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
      // "FK->LookupTable.Column" names the table the key already points to.
      const nextDot = next.lastIndexOf('.');
      const column = nextDot > 0 && key(next.slice(0, nextDot)) === key(fk.toTable) ? next.slice(nextDot + 1) : next;
      alias = joinAlias(alias, fk); entry = catalogApi.table(catalog, fk.toTable); name = column; lastHop = fk;
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
  const where = [], requestFilters = [], scope = [], textFilters = [], exclusions = [];
  for (const [filterIndex, filter] of (contract.filters || []).entries()) {
    const ref = resolve(filter.ref);
    const operator = filter.operator || 'eq';
    const source = fold(filter.inherited ? `${question}\n${previousQuestion}` : question);
    const evidence = fold(filter.evidence);
    if (!evidence || !source.includes(evidence)) throw fail('V2_FILTER_UNGROUNDED', `${filter.ref} "${filter.evidence}"`);
    const type = ref.column.type, name = ref.label;
    const identity = { table: ref.entry.tableName, column: ref.column.name, schemaName: ref.entry.schemaName };
    const value = filter.value;
    // Several periods ("2024-01 và 2024-02") are a union of half-open ranges.
    if (DATE_TYPES.has(type) && ['eq', 'period', 'in'].includes(operator) && (filter.values?.length > 1 || operator === 'in')) {
      const ranges = (filter.values?.length ? filter.values : [value]).map(item => ({ item, range: dateRange(item) }));
      if (ranges.some(entry => !entry.range)) throw fail('V2_PERIOD_INVALID', ranges.find(entry => !entry.range).item);
      where.push(`(${ranges.map(({ range }) => `(${ref.expr} >= '${range.from}' AND ${ref.expr} < '${range.to}')`).join(' OR ')})`);
      scope.push(`${name}: ${ranges.map(({ range }) => `${dmy(range.from)} – trước ${dmy(range.to)}`).join('; ')}`);
      continue;
    }
    if (DATE_TYPES.has(type) && ['eq', 'period'].includes(operator)) {
      const range = dateRange(value ?? filter.values?.[0]);
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
    // A flag ("hiện hữu", "đang hoạt động") only has two values; its grounding
    // is the quoted evidence, already checked above.
    if (type === 'bit' && ['eq', 'ne'].includes(operator)) {
      const flag = { true: 1, false: 0, 1: 1, 0: 0 }[String(value).toLowerCase()];
      if (flag === undefined) throw fail('V2_FILTER_TYPE', `${ref.column.name} = ${value}`);
      const on = operator === 'eq' ? flag : 1 - flag;
      where.push(on ? `${ref.expr} = 1` : `(${ref.expr} = 0 OR ${ref.expr} IS NULL)`);
      scope.push(`${name}: ${on ? 'có' : 'không'} ("${filter.evidence}")`);
      continue;
    }
    const values = ['in', 'notIn'].includes(operator) ? filter.values || [] : [value];
    if (!values.length || values.some(item => item === undefined || item === null || item === '')) throw fail('V2_FILTER_VALUE_REQUIRED', filter.ref);
    // A code or name never matches a numeric ID column: that needs a lookup.
    if (NUMERIC_TYPES.has(type) && values.some(item => !Number.isFinite(Number(item)))) throw fail('V2_FILTER_TYPE', `${ref.column.name} = ${values.join(',')}`);
    const asked = filter.resolvedFrom !== undefined ? [filter.resolvedFrom] : values;
    // A row reference ("người thứ 2 ở trên") is grounded by its quote in the
    // question plus a value the user actually saw in a previous result.
    const grounded = filter.fromResult ? asked.every(item => resultValues.has(fold(item)))
      : asked.every(item => mentions(evidence, item));
    if (!grounded) throw fail('V2_FILTER_UNGROUNDED', `${filter.ref} = ${values.join(',')}${filter.fromResult ? ' (not in the previous result)' : ''}`);
    if (operator === 'eq' && !NUMERIC_TYPES.has(type)) textFilters.push({ index: filterIndex, ...identity });
    if (['ne', 'notIn'].includes(operator) && !NUMERIC_TYPES.has(type)) exclusions.push({ index: filterIndex, ...identity, values });
    const sqlValues = values.map(item => NUMERIC_TYPES.has(type) ? String(Number(item)) : text(item));
    if (operator === 'contains') {
      const escaped = String(value).replace(/[%_[]/g, char => `[${char}]`);
      where.push(`${ref.expr} LIKE ${text(`%${escaped}%`)}`); scope.push(`${name} chứa "${value}"`);
    } else if (operator === 'in') {
      where.push(`${ref.expr} IN (${sqlValues.join(', ')})`); scope.push(`${name}: ${values.join(', ')}`);
    } else if (operator === 'ne' || operator === 'notIn') {
      // "Không phải X" keeps records whose lookup is empty: NULL is not X.
      const test = operator === 'ne' ? `${ref.expr} <> ${sqlValues[0]}` : `${ref.expr} NOT IN (${sqlValues.join(', ')})`;
      where.push(`(${test} OR ${ref.expr} IS NULL)`); scope.push(`${name} không phải: ${values.join(', ')}`);
    } else if (operator === 'eq') {
      where.push(`${ref.expr} = ${sqlValues[0]}`); scope.push(`${name} = ${value}`);
      requestFilters.push({ ...identity, value: NUMERIC_TYPES.has(type) ? Number(value) : value });
    } else throw fail('V2_OPERATOR_UNSUPPORTED', operator);
  }

  const select = [], groupBy = [], outputs = [];
  // Measures make an aggregate even when the contract omits the operation; an
  // explicit list that carries them is contradictory. (A list may group: "theo X".)
  const summarizes = Boolean(contract.measures?.length);
  if (contract.operation === 'list' && summarizes) throw fail('V2_OPERATION_MISMATCH', 'operation=list with measures; use operation=aggregate or drop the measures');
  const operation = contract.operation === 'aggregate' || (!contract.operation && summarizes) ? 'aggregate' : 'list';
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
      select.push(`${expression} AS ${quote(alias)}`); groupBy.push(expression); outputs.push({ alias, kind: 'dimension', ...(group.grain ? { grain: group.grain } : {}) });
    }
    if (!contract.measures?.length) throw fail('V2_MEASURE_REQUIRED');
    // An approved metric fixes the column, aggregation, name and conditions of
    // a measure. A raw measure equal to an unconditioned metric is that metric.
    const metrics = contract.measures.map(measure => {
      if (!measure.metric) {
        if (!measure.ref || !measure.aggregation) throw fail('V2_MEASURE_INVALID', 'a measure needs metric, or ref and aggregation');
        const aggregation = String(measure.aggregation).toUpperCase(), column = measure.ref === '*' ? null : String(measure.ref).split('.').pop();
        if (measure.distinct || String(measure.ref).includes('->') || (column && String(measure.ref).includes('.') && key(String(measure.ref).split('.')[0]) !== key(root.tableName))) return null;
        return (catalog.metrics || []).find(item => !item.conditions.length && key(item.table) === key(root.tableName) && item.aggregation === aggregation
          && (column ? key(item.column) === key(column) : aggregation === 'COUNT' && root.columns.get(key(item.column))?.pk)) || null;
      }
      const found = catalogApi.metric(catalog, measure.metric);
      if (!found) throw fail('V2_METRIC_UNKNOWN', measure.metric);
      if (key(found.table) !== key(root.tableName)) throw fail('V2_METRIC_ROOT', `${found.id} is on ${found.table}; use root=${found.table}`);
      return found;
    });
    // Conditions shared by every measure filter the rows; otherwise each
    // measure aggregates only its own rows (CASE inside the aggregate).
    const conditionsOf = metric => require('../../governance/metrics').conditionSql({ conditions: metric?.conditions || [] }, 't0');
    const shared = conditionsOf(metrics[0]).join(' AND ');
    const inWhere = Boolean(shared) && metrics.every(metric => conditionsOf(metric).join(' AND ') === shared);
    if (inWhere) where.push(...conditionsOf(metrics[0]));
    for (const [index, measure] of contract.measures.entries()) {
      const metric = metrics[index], conditions = inWhere ? [] : conditionsOf(metric);
      const aggregation = String(metric?.aggregation || measure.aggregation || '').toUpperCase();
      if (!AGGREGATE_LABELS[aggregation]) throw fail('V2_AGGREGATION_INVALID', aggregation);
      if (metric?.conditions.length) scope.push(`${metric.label}: theo định nghĩa chỉ tiêu (${conditionsOf(metric).join(' AND ').replaceAll('t0.', '')})`);
      const lineage = metric ? { metric: metric.id, metricVersion: metric.version, unit: metric.unit } : {};
      if (!metric && measure.ref === '*') {
        if (aggregation !== 'COUNT') throw fail('V2_AGGREGATION_INVALID', `${aggregation}(*)`);
        const alias = label(measure.label && !/^[A-Za-z0-9_]+$/.test(measure.label) ? measure.label : 'Số bản ghi', root);
        select.push(`COUNT(*) AS ${quote(alias)}`); outputs.push({ alias, kind: 'measure', aggregation: 'COUNT' });
        continue;
      }
      const ref = resolve(metric ? `${root.tableName}.${metric.column}` : measure.ref);
      // Values of a lookup repeat for every root row: only MIN/MAX/COUNT DISTINCT are meaningful there.
      if (ref.viaLookup && !['MIN', 'MAX'].includes(aggregation) && !(aggregation === 'COUNT' && measure.distinct)) throw fail('V2_MEASURE_GRAIN', measure.ref);
      if (['SUM', 'AVG'].includes(aggregation) && !NUMERIC_TYPES.has(ref.column.type)) throw fail('V2_MEASURE_NOT_NUMERIC', measure.ref);
      const named = metric ? metric.label : measure.label && !/^[A-Za-z0-9_]+$/.test(measure.label) ? measure.label : null;
      const alias = label(named || `${AGGREGATE_LABELS[aggregation]} ${ref.label}`, ref.entry);
      const value = conditions.length ? `CASE WHEN ${conditions.join(' AND ')} THEN ${ref.expr} END` : ref.expr;
      select.push(`${aggregation}(${aggregation === 'COUNT' && measure.distinct ? 'DISTINCT ' : ''}${value}) AS ${quote(alias)}`);
      outputs.push({ alias, kind: 'measure', aggregation, column: ref.column.name, ...lineage });
    }
  } else {
    // Default list: configured summary fields plus the business date and the
    // main labeled amount, so "liệt kê hóa đơn" shows when and how much.
    const money = (root.money || []).map(name => root.columns.get(key(name))).filter(item => item?.label);
    // Exactly one labeled after-tax amount (or a single labeled amount) is the
    // main amount; several candidates are ambiguous, so none is guessed.
    // A money column configured in the table's list fields is the main amount.
    const finals = money.filter(item => /final|sau thuế/i.test(`${item.name} ${item.label}`));
    const amount = money.find(item => root.defaults.some(name => key(name) === key(item.name)))
      || (finals.length === 1 ? finals[0] : !finals.length && money.length === 1 ? money[0] : null);
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
      select.push(`${ref.expr} AS ${quote(alias)}`); outputs.push({ alias, kind: 'field', ref: field });
    }
  }

  let orderBy = '';
  if (contract.sort?.by) {
    const direction = String(contract.sort.direction).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const measureIndex = /^measures?:(\d+)$/.exec(contract.sort.by)?.[1];
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
  const metrics = outputs.filter(item => item.metric).map(item => ({ id: item.metric, version: item.metricVersion }));
  return { sql, joinPlan, requestFilters, textFilters, exclusions, outputs, scope, operation, root: root.tableName, analysis: contract.analysis || 'none', metrics };
}

module.exports = { compile, metricRoot };
