'use strict';
const crypto = require('node:crypto');
const context = require('./context');
const identifier = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 128 };
const validate = new (require('ajv'))({ strict: false }).compile({ type: 'object', additionalProperties: false,
  required: ['metricId', 'owner', 'definition', 'table', 'valueColumn', 'aggregation', 'unit', 'grain', 'timeColumn', 'timezone', 'dimensions', 'nullRule', 'rounding', 'approved'],
  properties: { metricId: identifier, owner: { type: 'string', minLength: 1, maxLength: 200 }, definition: { type: 'string', minLength: 1, maxLength: 2000 },
    table: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*\\.[A-Za-z_][A-Za-z0-9_]*$', maxLength: 257 }, valueColumn: identifier,
    aggregation: { enum: ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'] }, unit: { type: 'string', minLength: 1, maxLength: 40 }, grain: { type: 'string', minLength: 1, maxLength: 200 },
    timeColumn: identifier, timezone: { enum: ['Asia/Ho_Chi_Minh', 'UTC'] }, dimensions: { type: 'array', items: identifier, uniqueItems: true, maxItems: 10 },
    nullRule: { enum: ['exclude', 'zero'] }, rounding: { type: 'integer', minimum: 0, maximum: 8 }, approved: { type: 'boolean' } } });
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
function sources() { return require('../services/sql_connector').dbSources; }
function list() {
  return sources().filter(source => context.canRead(source)).flatMap(source => (source.governedMetrics || []).filter(metric => metric.approved)
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
  require('./sql_policy').check(`SELECT ${definition.valueColumn}, ${definition.timeColumn}${definition.dimensions.length ? ', ' + definition.dimensions.join(', ') : ''} FROM ${definition.table}`, source);
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
  const sql = `SELECT ${group ? group + ', ' : ''}CAST(${expression} AS DECIMAL(38,${metric.rounding})) AS [value] FROM ${metric.table.split('.').map(quote).join('.')} WHERE ${quote(metric.timeColumn)} >= @metric_start AND ${quote(metric.timeColumn)} < @metric_end${group ? ` GROUP BY ${group} ORDER BY ${group}` : ''}`;
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
  const rows = require('../intelligent_core/security_guard').sanitizeTabularRows(await connector.executeSqlQuery(query.sql, metric.sourceId, toolContext.signal, query.parameters));
  return { rows, rowCount: rows.length, sourceId: metric.sourceId, metricId: metric.metricId, metricVersion: metric.version,
    units: { value: metric.unit }, grain: input.dimensions?.length ? input.dimensions.join(',') : 'aggregate',
    timeRange: { start: input.start, end: input.end, endExclusive: true, timezone: metric.timezone },
    asOf: new Date().toISOString(), complete: !input.dimensions?.length, hasMore: input.dimensions?.length ? rows.length >= 100 : false,
    lineage: [{ metricId: metric.metricId, version: metric.version, normalizedQueryHash: query.normalizedQueryHash, parameterHash: query.parameterHash }],
    assurance: 'source_supported', snapshot: 'live_read', sql: query.sql };
}
module.exports = { list, save, compile, execute, validate };
