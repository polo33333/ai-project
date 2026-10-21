'use strict';

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const validatePolicy = new (require('ajv'))().compile({ type: 'object', additionalProperties: false, properties: {
  revision: { type: 'string', minLength: 1 }, pricingRevision: { type: 'string', minLength: 1 },
  rates: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false,
    required: ['inputMicrosPerMillion', 'outputMicrosPerMillion'], properties: {
      inputMicrosPerMillion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      outputMicrosPerMillion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } } },
  thresholds: { type: 'object', additionalProperties: false, properties: {
    minRequests: { type: 'integer', minimum: 1 }, errorRate: { type: 'number', minimum: 0, maximum: 1 },
    p95Ms: { type: 'number', minimum: 0 }, maxCostMicros: { type: 'string', pattern: '^[0-9]+$' } } }
} });
function readPolicy() {
  const file = process.env.AGENT_OPERATIONS_POLICY_FILE;
  return file ? JSON.parse(require('node:fs').readFileSync(file, 'utf8')) : {};
}
async function loadAudits() {
  const storage=require('../storage');
  if(!storage.enabled())return require('../services/logger_service').chatHistory;
  return require('../storage/postgres/pool').transaction(storage.getPool(),async client=>{
    const records=await client.query(`SELECT r.id,r.payload->>'status' AS status,
      r.payload->'latencyMs' AS "latencyMs",r.payload->>'modelName' AS "modelName",
      r.payload#>'{requestPayload,answerEnvelope,requestAssessment}' AS assessment,
      r.payload#>'{requestPayload,tokenUsage}' AS usage,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('index',s.ordinality-1,'type','MODEL_USAGE',
        'model',s.value->'model','inputTokens',s.value->'inputTokens','outputTokens',s.value->'outputTokens',
        'usageAvailable',s.value->'usageAvailable') ORDER BY s.ordinality)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload#>'{requestPayload,diagnostics,steps}')='array'
          THEN r.payload#>'{requestPayload,diagnostics,steps}' ELSE '[]'::jsonb END) WITH ORDINALITY s(value,ordinality)
        WHERE s.value->>'type'='MODEL_USAGE'),'[]'::jsonb) AS steps
      FROM app.chat_runs r ORDER BY r.ordinal,r.id`);
    const tools=await client.query(`SELECT parent_id,payload->>'code' AS code,
      payload#>>'{toolResult,error,code}' AS nested_code FROM app.tool_executions
      WHERE payload->>'code' IS NOT NULL OR payload#>>'{toolResult,error,code}' IS NOT NULL`);
    const byRun=new Map();
    for(const row of tools.rows){if(!byRun.has(row.parent_id))byRun.set(row.parent_id,[]);byRun.get(row.parent_id).push({code:row.code||row.nested_code});}
    const decode=(value,path)=>value?.$khSecret===1?require('../storage/postgres/crypto').decrypt(value,path):value;
    return records.rows.map(({id,assessment,usage,steps,...row})=>({id,...row,requestPayload:{
      answerEnvelope:{requestAssessment:assessment},tokenUsage:decode(usage,`chat_runs/${id}/requestPayload/tokenUsage`),
      diagnostics:{steps:steps.map(({index,...step})=>({...step,
        inputTokens:decode(step.inputTokens,`chat_runs/${id}/requestPayload/diagnostics/steps/${index}/inputTokens`),
        outputTokens:decode(step.outputTokens,`chat_runs/${id}/requestPayload/diagnostics/steps/${index}/outputTokens`)}))},
      toolCalls:byRun.get(id)||[]}}));
  },{readOnly:true});
}
function summarize(audits, policy = {}) {
  if (!validatePolicy(policy)) throw Object.assign(new Error('OPERATIONS_POLICY_INVALID'), { code: 'OPERATIONS_POLICY_INVALID' });
  const statuses = Object.create(null), codes = Object.create(null), timings = [], models = new Map();
  let missingCriteria = 0, usageUnavailable = 0, incompleteCosts = 0, cost = 0n;
  for (const audit of audits) {
    statuses[audit.status || 'UNKNOWN'] = (statuses[audit.status || 'UNKNOWN'] || 0) + 1;
    if (typeof audit.latencyMs === 'number' && Number.isFinite(audit.latencyMs) && audit.latencyMs >= 0) timings.push(audit.latencyMs);
    const payload = audit.requestPayload || {};
    const assessment = payload.answerEnvelope?.requestAssessment;
    if (assessment?.complete === false) missingCriteria++;
    const calls = payload.diagnostics?.steps?.filter(step => step.type === 'MODEL_USAGE') || [];
    const usage = calls.length ? calls : payload.tokenUsage?.available ? [{ ...payload.tokenUsage, model: audit.modelName }] : [];
    if (!usage.length) { usageUnavailable++; incompleteCosts++; }
    for (const call of usage) {
      if (!Number.isSafeInteger(call.inputTokens) || !Number.isSafeInteger(call.outputTokens)
        || call.inputTokens < 0 || call.outputTokens < 0 || call.usageAvailable === false) {
        usageUnavailable++; incompleteCosts++; continue;
      }
      const model = call.model || audit.modelName || 'unknown';
      if (!models.has(model)) models.set(model, { calls: 0, inputTokens: 0, outputTokens: 0 });
      const total = models.get(model); total.calls++; total.inputTokens += call.inputTokens; total.outputTokens += call.outputTokens;
      const rate = policy.rates?.[model];
      if (!rate || !Number.isSafeInteger(rate.inputMicrosPerMillion) || !Number.isSafeInteger(rate.outputMicrosPerMillion)
        || rate.inputMicrosPerMillion < 0 || rate.outputMicrosPerMillion < 0 || !policy.pricingRevision) { incompleteCosts++; continue; }
      const numerator = BigInt(call.inputTokens) * BigInt(rate.inputMicrosPerMillion) + BigInt(call.outputTokens) * BigInt(rate.outputMicrosPerMillion);
      cost += (numerator + 999999n) / 1000000n;
    }
    for (const call of payload.toolCalls || []) {
      const code = call.code || call.toolResult?.error?.code;
      if (code) codes[code] = (codes[code] || 0) + 1;
    }
  }
  const failures = ['ERROR', 'FAILED', 'DENIED'].reduce((sum, state) => sum + (statuses[state] || 0), 0);
  const report = { reportVersion: '1', requests: audits.length, statuses, missingCriteria, errorCodes: codes,
    latency: { measured: timings.length, p50Ms: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95) },
    usage: { byModel: Object.fromEntries(models), unavailable: usageUnavailable },
    cost: { currency: 'USD', unit: 'microUSD', pricingRevision: policy.pricingRevision || null,
      pricedSubtotal: cost.toString(), total: incompleteCosts ? null : cost.toString(), unpricedCallsOrRequests: incompleteCosts },
    alerts: [], policyRevision: policy.revision || null };
  const thresholds = policy.thresholds;
  if (thresholds && audits.length >= (thresholds.minRequests || 1)) {
    if (Number.isFinite(thresholds.errorRate) && audits.length && failures / audits.length > thresholds.errorRate) report.alerts.push({ code: 'ERROR_RATE_HIGH', value: failures / audits.length, threshold: thresholds.errorRate });
    if (Number.isFinite(thresholds.p95Ms) && report.latency.p95Ms !== null && report.latency.p95Ms > thresholds.p95Ms) report.alerts.push({ code: 'LATENCY_P95_HIGH', value: report.latency.p95Ms, threshold: thresholds.p95Ms });
    if (typeof thresholds.maxCostMicros === 'string' && report.cost.total !== null && BigInt(report.cost.total) > BigInt(thresholds.maxCostMicros)) report.alerts.push({ code: 'COST_BUDGET_EXCEEDED', value: report.cost.total, threshold: thresholds.maxCostMicros });
  }
  if (!policy.revision) report.alerts.push({ code: 'OPERATIONS_POLICY_UNCONFIGURED' });
  if (incompleteCosts) report.alerts.push({ code: 'COST_EVIDENCE_INCOMPLETE', count: incompleteCosts });
  return report;
}

function releaseGate({ checks, previousRevision, candidateRevision }) {
  const required = ['tests', 'businessRegression', 'permissions', 'injection', 'noFabrication', 'channelAcceptance', 'rollbackVerified'];
  const missing = required.filter(name => checks?.[name] !== 'passed');
  if (!previousRevision || !candidateRevision || previousRevision === candidateRevision) missing.push('distinctRevisions');
  return { schemaVersion: '1', decision: missing.length ? 'hold' : 'canary_eligible', missing,
    previousRevision: previousRevision || null, candidateRevision: candidateRevision || null,
    rollbackScope: 'application_code_only', preserve: ['database', 'permissions', 'memory', 'userFiles', 'environment'],
    automaticDeployment: false };
}

function feedbackCases(feedback, audits) {
  const byId = new Map(audits.map(audit => [audit.id, audit]));
  const cases = [], skipped = [];
  for (const item of feedback) {
    const audit = byId.get(item.auditId);
    if (item.reviewStatus !== 'approved' || !item.reviewedAt || !item.reviewedBy || !item.reviewExpectedOutcome || !audit) { skipped.push(item.id); continue; }
    cases.push({ id: `feedback:${item.id}`, sourceAuditId: audit.id, question: audit.question,
      expectedOutcome: item.reviewExpectedOutcome, groupId: audit.requestPayload?.sessionId || audit.id,
      approvedAt: item.reviewedAt, reviewer: item.reviewedBy || null });
  }
  return { schemaVersion: '1', cases, skipped, warning: 'Private regression inputs; review redaction before sharing. No SQL results exported.' };
}
module.exports = { summarize, releaseGate, feedbackCases, readPolicy, loadAudits };
