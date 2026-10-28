'use strict';
const crypto = require('node:crypto');

const dispositions = new Set(['answered', 'partial', 'clarify', 'no_evidence', 'denied', 'pending', 'cancelled', 'error']);
const pending = new Set(['CREATED', 'READY', 'RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL', 'NEEDS_REVIEW']);
const legacy = Object.freeze({ SUCCESS: 'answered', PARTIAL: 'partial', ERROR: 'error',
  CLARIFY: 'clarify', CLARIFICATION: 'clarify', NO_EVIDENCE: 'no_evidence', DENIED: 'denied', CANCELLED: 'cancelled' });

function disposition(result) {
  if (result.execution?.status === 'CANCELLED') return 'cancelled';
  if (result.execution?.status === 'FAILED') return 'error';
  if (pending.has(result.execution?.status)) return 'pending';
  if (dispositions.has(result.disposition) && !['answered', 'partial'].includes(result.disposition)) return result.disposition;
  if (result.success === false) return 'error';
  if (result.trace?.contractAssessment?.complete === false) return 'partial';
  if (dispositions.has(result.disposition)) return result.disposition;
  return legacy[result.trace?.completionStatus] || 'partial';
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Compatibility adapter only. SUCCESS means completion, never claim verification.
// Structured bindings are source-supported; free prose remains unverified.
function createAnswerEnvelope(result = {}) {
  const reply = String(result.replyText || '');
  const governance = require('../../governance/context');
  const scope = governance.current();
  if (scope) {
    scope.answerCache ||= new WeakMap();
    if (scope.answerCache.has(result)) return scope.answerCache.get(result);
  }
  const context = { ...governance.summary(), requestId: governance.current()?.requestId || null, observedAt: new Date().toISOString() };
  const evidence = require('../../governance/evidence').assemble(result, context);
  const assessment = result.trace?.contractAssessment;
  const requestAssessment = assessment ? {
    schemaVersion: '1', complete: assessment.complete === true,
    fields: (assessment.fields || []).map(field => ({ name: field.name, status: field.status })),
    failures: [...(assessment.failures || [])],
    // This describes structured criterion coverage only, not free-prose verification.
    assurance: 'structured_criteria_only'
  } : null;
  const body = {
    schemaVersion: '1', adapterVersion: 'legacy/1',
    disposition: disposition(result),
    claims: evidence.claims, evidence: evidence.records, evidenceAssessment: evidence.assessment,
    ...(requestAssessment ? { requestAssessment } : {}),
    assumptions: [], limitations: evidence.records.length ? ['Phần diễn giải chưa được đối chiếu tự động với toàn bộ dữ kiện nguồn.'] : [],
    citations: structuredClone(result.citations || []),
    artifacts: (result.toolCalls || []).filter(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl)
      .map(call => ({ downloadUrl: call.result.downloadUrl, fileName: call.result.fileName || null })),
    executionRef: result.execution ? { runId: result.execution.id || result.execution.runId || null,
      status: result.execution.status, templateVersion: result.execution.templateVersion || null } : null,
    reasonCodes: [evidence.claims.length ? 'PROSE_NOT_VERIFIED' : 'LEGACY_CLAIMS_NOT_ASSESSED', ...(result.errorCode ? [result.errorCode] : [])],
    policyRevision: context.policyRevision,
    replyHash: crypto.createHash('sha256').update(reply).digest('hex')
  };
  const envelope = freeze({ ...body, answerRevision: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') });
  if (scope) {
    scope.answerCache.set(result, envelope);
    scope.finalEnvelope = envelope;
    scope.evidencePayloads = evidence.payloads;
  }
  return envelope;
}

module.exports = { createAnswerEnvelope, disposition };
