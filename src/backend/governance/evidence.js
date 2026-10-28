'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function assemble(result, context) {
  const records = [], claims = [], payloads = {};
  let bytes = 0;
  const scope = context.scopeRef;
  for (const [index, call] of (result.toolCalls || []).entries()) {
    if (!call.success || !call.result || !['execute_sql_query', 'query_sql_metric', 'search_knowledge_base', 'get_workflow_dataset'].includes(call.toolName)) continue;
    const payload = structuredClone(call.result);
    if (Array.isArray(payload.rows)) payload.rows = require('../assistant/security_guard').sanitizeTabularRows(payload.rows);
    const size = Buffer.byteLength(JSON.stringify(payload));
    if (bytes + size > 2 * 1024 * 1024) continue;
    bytes += size;
    const evidenceId = hash([context.requestId, scope, index, payload]);
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const record = { schemaVersion: '1', evidenceId, requestId: context.requestId || null, toolCallId: `tool:${index}`,
      sourceType: ['execute_sql_query', 'query_sql_metric'].includes(call.toolName) ? 'sql' : call.toolName === 'get_workflow_dataset' ? 'workflow' : 'document',
      sourceId: payload.sourceId || payload.dbSourceId || call.args?.workflowRunId || null, sourceRevision: payload.sourceRevision || null,
      observedAt: context.observedAt, asOf: payload.asOf || null, scopeRef: scope, policyRevision: context.policyRevision,
      sensitivity: context.sensitivity || 'internal', contentHash: hash(payload), payloadRef: `audit:evidencePayloads:${evidenceId}`,
      locators: [], completeness: payload.hasMore || payload.truncated ? 'partial' : payload.complete === true ? 'complete' : 'unknown',
      truncationReason: payload.hasMore ? 'PAGINATED' : payload.truncated ? 'SOURCE_TRUNCATED' : null, lineage: payload.lineage || [] };
    records.push(record);
    payloads[evidenceId] = payload;
    // Bind individual structured values. This makes no claim that free-form prose
    // is supported, or that a returned preview is a complete business aggregate.
    if (scope && record.sourceType === 'sql') {
      for (const [rowIndex, row] of rows.slice(0, 32).entries()) {
        for (const [column, value] of Object.entries(row)) {
          const decimalMetric = payload.metricId && column === 'value' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
          if (claims.length >= 128 || (!decimalMetric && (typeof value !== 'number' || !Number.isFinite(value)))) continue;
          claims.push({ claimId: `${evidenceId}:${rowIndex}:${column}`, kind: 'sourced_fact', evidenceIds: [evidenceId],
            valueRef: { row: rowIndex, column }, value, unit: payload.units?.[column] || null, grain: payload.grain || null,
            metricId: payload.metricId || null, metricVersion: payload.metricVersion || null, timeRange: payload.timeRange || null,
            checks: [{ type: 'structured_value_binding', status: 'passed', validatorVersion: '1' }], assurance: 'source_supported' });
        }
      }
    }
  }
  const assessment = { requirementId: 'legacy-answer', evidenceIds: records.map(record => record.evidenceId),
    coverage: records.some(record => record.completeness === 'partial') ? 'partial' : 'unknown',
    adequacy: 'undetermined', conflicts: [], freshness: 'unknown', reasons: ['QUESTION_COVERAGE_NOT_ASSESSED'] };
  return freeze({ records, claims, assessment, payloads });
}
function percentageChange(before, after) {
  // Decimal inputs stay fixed precision until formatting; no floating point money math.
  const parse = value => { const match = /^(-?)(\d+)(?:\.(\d{1,8}))?$/.exec(String(value)); if (!match) throw new Error('INVALID_DECIMAL'); return BigInt(`${match[1]}${match[2]}${(match[3] || '').padEnd(8, '0')}`); };
  const a = parse(before), b = parse(after);
  if (a === 0n) return { value: null, reasonCode: 'ZERO_DENOMINATOR', direction: b === 0n ? 'unchanged' : b > 0n ? 'increase' : 'decrease' };
  const scaled = (b - a) * 10000n / (a < 0n ? -a : a);
  const absolute = scaled < 0n ? -scaled : scaled;
  return { value: `${scaled < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`, unit: '%', rounding: 'truncate_2dp',
    direction: b === a ? 'unchanged' : b > a ? 'increase' : 'decrease' };
}
module.exports = { assemble, percentageChange };
