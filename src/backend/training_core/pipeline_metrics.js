'use strict';

// Request-level metrics from the chat audit log: which path answered each
// question (v2 contract pipeline, its fallback to the agent loop, or older
// routes), how often it succeeded, asked back or failed, and what it cost in
// model calls, tokens and time. Pure functions over audit records.

// Audit timestamps are ISO strings or "HH:mm:ss dd/MM/yyyy" (server local time).
function parseTime(value) {
  if (!value) return null;
  const local = String(value).match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const time = local ? new Date(+local[6], +local[5] - 1, +local[4], +local[1], +local[2], +local[3]) : new Date(value);
  return Number.isFinite(time.getTime()) ? time : null;
}

function route(record) {
  const diagnostics = record.requestPayload?.diagnostics || {};
  if (record.status === 'ERROR') return 'error';
  if (diagnostics.pipeline === 'v2') return 'v2';
  if (diagnostics.v2Attempt) return 'v2_fallback';
  if (diagnostics.harness === 'provider_guarded') return 'agent_loop';
  if (diagnostics.harness) return diagnostics.harness;
  return 'legacy';
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))] : null;
}

function summary(values) {
  const list = values.filter(Number.isFinite);
  return { count: list.length, mean: list.length ? Math.round(list.reduce((sum, value) => sum + value, 0) / list.length) : null,
    p50: quantile(list, 0.5), p90: quantile(list, 0.9), p95: quantile(list, 0.95) };
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) for (const value of [].concat(key(item)).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
}

const share = (part, total) => total ? +(part / total).toFixed(3) : null;
const dayKey = time => `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;

// One normalized row per answered request.
function toRow(record) {
  const payload = record.requestPayload || {};
  const diagnostics = payload.diagnostics || {};
  const usage = (diagnostics.steps || []).filter(step => step.type === 'MODEL_USAGE');
  const failures = diagnostics.responseEvaluation?.failures || [];
  return {
    id: record.id, time: parseTime(record.timestamp), route: route(record), status: record.status || 'UNKNOWN',
    endpoint: payload.endpoint || 'unknown', provider: record.providerName || payload.providerName || null,
    sessionId: payload.sessionId || payload.memoryDecision?.sessionId || null,
    latencyMs: Number.isFinite(record.latencyMs) ? record.latencyMs : null,
    modelCalls: Number.isFinite(diagnostics.executionBudget?.modelCalls) ? diagnostics.executionBudget.modelCalls
      : usage.length ? usage.reduce((sum, step) => sum + (Number(step.calls) || 1), 0) : (Number(payload.tokenUsage?.calls) || null),
    inputTokens: Number(payload.tokenUsage?.inputTokens) || null,
    outputTokens: Number(payload.tokenUsage?.outputTokens) || null,
    cachedInputTokens: usage.reduce((sum, step) => sum + (Number(step.cachedInputTokens) || 0), 0),
    clarify: failures.includes('V2_CLARIFY'),
    fallbackCode: diagnostics.v2Attempt ? diagnostics.v2Attempt.fallbackCode || 'UNKNOWN' : null,
    contractKind: diagnostics.v2Contract?.kind || null,
    operation: diagnostics.v2Contract?.operation || diagnostics.plan?.operation || diagnostics.plan?.intent || null,
    failures, stages: usage.map(step => ({ stage: step.stage || 'unknown', inputTokens: Number(step.inputTokens) || 0, calls: Number(step.calls) || 1 }))
  };
}

function aggregate(rows) {
  const total = rows.length;
  const byStatus = Object.fromEntries(['SUCCESS', 'PARTIAL', 'ERROR'].map(status => [status, rows.filter(row => row.status === status).length]));
  const input = rows.reduce((sum, row) => sum + (row.inputTokens || 0), 0);
  const cached = rows.reduce((sum, row) => sum + row.cachedInputTokens, 0);
  return { total, byStatus, successRate: share(byStatus.SUCCESS, total), clarifyRate: share(rows.filter(row => row.clarify).length, total),
    modelCalls: summary(rows.map(row => row.modelCalls)), latencyMs: summary(rows.map(row => row.latencyMs)),
    inputTokens: summary(rows.map(row => row.inputTokens)), outputTokens: summary(rows.map(row => row.outputTokens)),
    cache: { inputTokens: input, cachedInputTokens: cached, cachedShare: share(cached, input) } };
}

// excludeSessions: prefixes of sessions that are not real use (evaluation runs).
function computeMetrics(records = [], { since = null, until = null, excludeSessionPrefixes = ['eval-'] } = {}) {
  const rows = records.map(toRow).filter(row => row.time
    && (!since || row.time >= since) && (!until || row.time < until)
    && !excludeSessionPrefixes.some(prefix => String(row.sessionId || '').startsWith(prefix)))
    .sort((a, b) => a.time - b.time);
  const firstV2 = rows.find(row => row.route === 'v2' || row.route === 'v2_fallback')?.time || null;
  const v2Era = firstV2 ? rows.filter(row => row.time >= firstV2) : [];
  // Data questions handled by v2: answered in v2 versus handed to the agent loop.
  const v2Handled = v2Era.filter(row => ['v2', 'v2_fallback'].includes(row.route));
  const stageRows = rows.flatMap(row => row.stages);
  return {
    window: { from: rows[0]?.time.toISOString() || null, to: rows.at(-1)?.time.toISOString() || null, firstV2: firstV2?.toISOString() || null },
    overall: aggregate(rows),
    v2Era: { ...aggregate(v2Era),
      deterministicShare: share(v2Handled.filter(row => row.route === 'v2').length, v2Handled.length),
      fallbackShare: share(v2Handled.filter(row => row.route === 'v2_fallback').length, v2Handled.length) },
    routes: countBy(rows, row => row.route).map(item => ({ ...item, ...aggregate(rows.filter(row => row.route === item.name)) })),
    fallbackCodes: countBy(rows.filter(row => row.fallbackCode), row => row.fallbackCode),
    contractKinds: countBy(rows.filter(row => row.contractKind), row => row.contractKind),
    operations: countBy(rows.filter(row => row.operation), row => row.operation),
    failures: countBy(rows, row => row.failures).slice(0, 15),
    endpoints: countBy(rows, row => row.endpoint),
    providers: countBy(rows.filter(row => row.provider), row => row.provider),
    stages: countBy(stageRows, stage => stage.stage).map(item => {
      const list = stageRows.filter(stage => stage.stage === item.name);
      return { ...item, inputTokens: summary(list.map(stage => stage.inputTokens)) };
    }),
    daily: [...new Set(rows.map(row => dayKey(row.time)))].map(day => {
      const list = rows.filter(row => dayKey(row.time) === day);
      const handled = list.filter(row => ['v2', 'v2_fallback'].includes(row.route));
      return { day, total: list.length, successRate: share(list.filter(row => row.status === 'SUCCESS').length, list.length),
        v2Share: share(list.filter(row => row.route === 'v2').length, handled.length),
        latencyP50: quantile(list.map(row => row.latencyMs), 0.5), modelCallsP50: quantile(list.map(row => row.modelCalls), 0.5),
        inputTokensMean: summary(list.map(row => row.inputTokens)).mean };
    })
  };
}

module.exports = { computeMetrics, parseTime, route, toRow, quantile };
