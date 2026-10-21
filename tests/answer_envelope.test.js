'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnswerEnvelope } = require('../src/backend/agent_core/harness/answer_envelope');

test('legacy completion never becomes a verified factual claim', () => {
  const answer = createAnswerEnvelope({ success: true, replyText: 'A value', trace: { completionStatus: 'SUCCESS' } });
  assert.equal(answer.disposition, 'answered'); assert.equal(answer.schemaVersion, '1');
  assert.deepEqual(answer.claims, []); assert.ok(answer.reasonCodes.includes('LEGACY_CLAIMS_NOT_ASSESSED'));
  assert.equal(answer.policyRevision, null);
});
test('pending input, approval, running, cancellation and source error remain distinct', () => {
  for (const status of ['WAITING_INPUT', 'WAITING_APPROVAL', 'RUNNING', 'NEEDS_REVIEW']) {
    const answer = createAnswerEnvelope({ success: true, execution: { id: 'run', status } });
    assert.equal(answer.disposition, 'pending'); assert.equal(answer.executionRef.status, status);
  }
  assert.equal(createAnswerEnvelope({ execution: { status: 'CANCELLED' } }).disposition, 'cancelled');
  assert.equal(createAnswerEnvelope({ success: false, errorCode: 'SOURCE_UNAVAILABLE' }).disposition, 'error');
  assert.equal(createAnswerEnvelope({ disposition: 'no_evidence' }).disposition, 'no_evidence');
});
test('answer revision freezes a detached copy and changes when rendered reply changes', () => {
  const source = { replyText: 'First', citations: [{ sourceId: 'doc', revision: '1' }] };
  const answer = createAnswerEnvelope(source);
  source.citations[0].revision = '2';
  assert.equal(answer.citations[0].revision, '1');
  assert.throws(() => { answer.disposition = 'answered'; }, TypeError);
  assert.throws(() => answer.citations.push({}), TypeError);
  assert.notEqual(answer.answerRevision, createAnswerEnvelope({ ...source, replyText: 'Second' }).answerRevision);
});

test('all channels receive immutable structured coverage and cannot report missing criteria as answered', () => {
  const result = { success: true, replyText: 'Rows', trace: { completionStatus: 'SUCCESS',
    contractAssessment: { complete: false, fields: [{ name: 'displayField', status: 'not_queried' }],
      failures: ['CONTRACT_FIELDS_NOT_QUERIED'], internalPayload: 'never export' } } };
  const answer = createAnswerEnvelope(result);
  assert.equal(answer.disposition, 'partial');
  assert.equal(answer.requestAssessment.assurance, 'structured_criteria_only');
  assert.equal(JSON.stringify(answer).includes('never export'), false);
  result.trace.contractAssessment.fields[0].status = 'present';
  assert.equal(answer.requestAssessment.fields[0].status, 'not_queried');
  assert.throws(() => answer.requestAssessment.failures.push('changed'), TypeError);
  assert.equal(createAnswerEnvelope({ ...result, execution: { status: 'CANCELLED' } }).disposition, 'cancelled');
  assert.equal(createAnswerEnvelope({ ...result, disposition: 'denied' }).disposition, 'denied');
  assert.equal(createAnswerEnvelope({ ...result, success: false }).disposition, 'error');
});
