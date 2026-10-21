'use strict';
// Offline verification only: deliberately imports no connectors, model, memory or runtime.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function verify(audit) {
  const envelope = audit.requestPayload?.answerEnvelope, payloads = audit.requestPayload?.evidencePayloads || {};
  const failures = [];
  if (!envelope) return { id: audit.id || null, status: 'unavailable', failures: ['ENVELOPE_MISSING'] };
  const { answerRevision, ...body } = envelope;
  if (hash(body) !== answerRevision) failures.push('ANSWER_REVISION_MISMATCH');
  if (crypto.createHash('sha256').update(String(audit.replyText || '')).digest('hex') !== envelope.replyHash) failures.push('REPLY_HASH_MISMATCH');
  const records = new Map((envelope.evidence || []).map(record => [record.evidenceId, record]));
  for (const record of records.values()) {
    if (!Object.hasOwn(payloads, record.evidenceId)) failures.push(`EVIDENCE_MISSING:${record.evidenceId}`);
    else if (hash(payloads[record.evidenceId]) !== record.contentHash) failures.push(`EVIDENCE_HASH_MISMATCH:${record.evidenceId}`);
  }
  for (const claim of envelope.claims || []) {
    if (!(claim.evidenceIds || []).length || claim.evidenceIds.some(id => !records.has(id))) failures.push(`CLAIM_EVIDENCE_MISSING:${claim.claimId}`);
    if (claim.valueRef && claim.evidenceIds?.length === 1) {
      const payload = payloads[claim.evidenceIds[0]], value = payload?.rows?.[claim.valueRef.row]?.[claim.valueRef.column];
      if (!Object.is(value, claim.value)) failures.push(`CLAIM_VALUE_MISMATCH:${claim.claimId}`);
    }
  }
  return { id: audit.id || null, status: failures.length ? 'failed' : 'passed', failures, assurance: 'contract_integrity_only',
    liveQualityAssessed: false, sideEffects: 0, modelCalls: 0, memoryWrites: 0 };
}
module.exports = { verify };
