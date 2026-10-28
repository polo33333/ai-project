'use strict';
const crypto = require('node:crypto');
const context = require('./context');
const identifier = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 128 };
const literal = { type: ['string', 'number'], maxLength: 200 };
const validate = new (require('ajv'))({ strict: false }).compile({ type: 'object', additionalProperties: false,
  required: ['metricId', 'owner', 'definition', 'table', 'valueColumn', 'aggregation', 'unit', 'grain', 'timeColumn', 'timezone', 'dimensions', 'nullRule', 'rounding', 'approved'],
  properties: { metricId: identifier, owner: { type: 'string', minLength: 1, maxLength: 200 }, definition: { type: 'string', minLength: 1, maxLength: 2000 },
    table: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$', maxLength: 257 }, valueColumn: identifier,
    aggregation: { enum: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'] }, unit: { type: 'string', minLength: 1, maxLength: 40 }, grain: { type: 'string', minLength: 1, maxLength: 200 },
    timeColumn: identifier, timezone: { enum: ['Asia/Ho_Chi_Minh', 'UTC'] }, dimensions: { type: 'array', items: identifier, uniqueItems: true, maxItems: 10 },
    nullRule: { enum: ['exclude', 'zero'] }, rounding: { type: 'integer', minimum: 0, maximum: 8 }, approved: { type: 'boolean' },
    // Business name and wording users ask with; offered to the v2 query contract.
    label: { type: 'string', minLength: 1, maxLength: 120 },
    aliases: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 80 } },
    // Fixed conditions on the metric's own table that are part of its meaning
    // (a fee line type, a document kind); every query of the metric applies them.
    conditions: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['column', 'operator'], properties: {
      column: identifier, operator: { enum: ['eq', 'ne', 'in', 'notIn', 'isNull', 'notNull'] }, value: literal,
      values: { type: 'array', minItems: 1, maxItems: 20, items: literal } } } } } });
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });

// T-SQL predicates for a metric's fixed conditions, on the table alias given.
// "Not X" keeps empty values, as in the query compiler: NULL is not X.
function conditionSql(metric, alias = '') {
  const column = name => `${alias ? `${alias}.` : ''}[${name}]`;
  const value = item => typeof item === 'number' && Number.isFinite(item) ? String(item) : `N'${String(item).replaceAll("'", "''")}'`;
  return (metric.conditions || []).map(condition => {
    const target = column(condition.column), values = condition.values || [condition.value];
    if (condition.operator === 'isNull' || condition.operator === 'notNull') return `${target} IS ${condition.operator === 'isNull' ? '' : 'NOT '}NULL`;
    if (values.some(item => item === undefined || item === null || item === '')) throw fail('METRIC_CONDITION_INVALID');
    if (condition.operator === 'eq') return `${target} = ${value(values[0])}`;
    if (condition.operator === 'in') return `${target} IN (${values.map(value).join(', ')})`;
    return `(${target} ${condition.operator === 'ne' ? `<> ${value(values[0])}` : `NOT IN (${values.map(value).join(', ')})`} OR ${target} IS NULL)`;
  });
}
function sources() { return require('../services/sql_connector').dbSources; }
// Q8: a metric is offered only when its table and columns are in the caller's table scope.
function inScope(source, metric) {
  if (!context.current()) return true;
  const scope = require('./scope').forCurrent(source), key = require('./scope').key;
  if (scope.open && !scope.policy.sql.hiddenTables.length) return true;
  const [schemaName, tableName] = String(metric.table || '').includes('.') ? String(metric.table).split('.') : ['dbo', metric.table];
  const entry = scope.lookup.get(key(`${schemaName}.${tableName}`)) || scope.lookup.get(key(tableName));
  if (!entry || entry.level === 'bridge') return false;
  return [metric.valueColumn, metric.timeColumn, ...(metric.dimensions || []), ...(metric.conditions || []).map(condition => condition.column)]
    .filter(Boolean).every(column => entry.columns.has(key(column)));
}
function list() {
  return sources().filter(source => context.canRead(source, 'sql')).flatMap(source => (source.governedMetrics || []).filter(metric => metric.approved && inScope(source, metric))
    .map(metric => ({ ...structuredClone(metric), sourceId: source.id })));
}
function save(sourceId, definition, expectedRevision) {
  if (context.principal()?.role !== 'admin') throw fail('METRIC_ADMIN_REQUIRED', 403);
  if (!validate(definition)) throw fail('METRIC_DEFINITION_INVALID');
  const source = sources().find(item => item.id === sourceId); if (!source) throw fail('SOURCE_NOT_FOUND', 404);
  context.read(source, 'sql');
  const metrics = source.governedMetrics ||= [], index = metrics.findIndex(item => item.metricId === definition.metricId), old = metrics[index];
  if (expectedRevision !== (old?.version || 0)) throw fail('METRIC_REVISION_CONFLICT', 409);
  const record = { ...structuredClone(definition), version: (old?.version || 0) + 1, dialect: 'TransactSQL',
    updatedAt: new Date().toISOString(), approvedBy: definition.approved ? context.principal()?.subject || null : null,
    permittedJoins: [], effectiveFrom: new Date().toISOString() };
  // Validate source/table/column restrictions before publishing a definition.
  const conditions = conditionSql(definition);
  require('./sql_policy').check(`SELECT ${definition.valueColumn}, ${definition.timeColumn}${definition.dimensions.length ? ', ' + definition.dimensions.join(', ') : ''} FROM ${definition.table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`, source);
  if (index < 0) metrics.push(record); else metrics[index] = record;
  require('../services/sql_connector').persist(); return structuredClone(record);
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw fail('METRIC_DATE_INVALID');
  return value;
}
function compile(metric, input) {
  const start = date(input.start), end = date(input.end); if (start >= end) throw fail('METRIC_RANGE_INVALID');
  const dimensions = input.dimensions || [];
  if (!Array.isArray(dimensions) || dimensions.length > 10 || new Set(dimensions).size !== dimensions.length || dimensions.some(item => !metric.dimensions.includes(item))) throw fail('METRIC_DIMENSION_DENIED');
  const quote = name => `[${name}]`, value = metric.nullRule === 'zero' ? `COALESCE(${quote(metric.valueColumn)}, 0)` : quote(metric.valueColumn);
  // SQL DECIMAL keeps monetary aggregation outside JavaScript floating point.
  const expression = metric.aggregation === 'COUNT' ? `COUNT_BIG(${quote(metric.valueColumn)})` : `${metric.aggregation}(CAST(${value} AS DECIMAL(38,8)))`;
  const group = dimensions.map(quote).join(', ');
  const conditions = conditionSql(metric).map(condition => ` AND ${condition}`).join('');
  const sql = `SELECT ${group ? group + ', ' : ''}CAST(${expression} AS DECIMAL(38,${metric.rounding})) AS [value] FROM ${metric.table.split('.').map(quote).join('.')} WHERE ${quote(metric.timeColumn)} >= @metric_start AND ${quote(metric.timeColumn)} < @metric_end${conditions}${group ? ` GROUP BY ${group} ORDER BY ${group}` : ''}`;
  return { sql, parameters: [{ name: 'metric_start', type: 'date', value: start }, { name: 'metric_end', type: 'date', value: end }],
    normalizedQueryHash: crypto.createHash('sha256').update(sql).digest('hex'),
    parameterHash: crypto.createHash('sha256').update(JSON.stringify([start, end, dimensions])).digest('hex') };
}
async function execute(input, toolContext = {}) {
  if (!Array.isArray(toolContext.permissions) || !toolContext.permissions.some(permission => ['admin', '*', 'sql:read'].includes(permission))) throw fail('METRIC_PERMISSION_DENIED', 403);
  const candidates = list().filter(metric => metric.metricId === input.metricId && (!input.sourceId || metric.sourceId === input.sourceId));
  if (candidates.length !== 1) throw fail(candidates.length ? 'METRIC_SOURCE_AMBIGUOUS' : 'METRIC_NOT_FOUND', 404);
  const metric = candidates[0], query = compile(metric, input), connector = require('../services/sql_connector');
  toolContext.executionBudget?.consumeSqlAttempt();
  const rows = require('../assistant/security_guard').sanitizeTabularRows(await connector.executeSqlQuery(query.sql, metric.sourceId, toolContext.signal, query.parameters));
  return { rows, rowCount: rows.length, sourceId: metric.sourceId, metricId: metric.metricId, metricVersion: metric.version,
    units: { value: metric.unit }, grain: input.dimensions?.length ? input.dimensions.join(',') : 'aggregate',
    timeRange: { start: input.start, end: input.end, endExclusive: true, timezone: metric.timezone },
    asOf: new Date().toISOString(), complete: !input.dimensions?.length, hasMore: input.dimensions?.length ? rows.length >= 100 : false,
    lineage: [{ metricId: metric.metricId, version: metric.version, normalizedQueryHash: query.normalizedQueryHash, parameterHash: query.parameterHash }],
    assurance: 'source_supported', snapshot: 'live_read', sql: query.sql };
}
module.exports = { list, save, compile, execute, validate, conditionSql };
