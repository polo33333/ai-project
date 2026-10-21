'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../scripts/eval/retrieval_measurement');
const languageGroups = ['accented', 'unaccented', 'abbreviation', 'compound', 'typo', 'reference'];
function input(block = 'E1') {
  const labels = languageGroups.map((languageGroup, index) => ({ caseId: `case-${index}`, block, groupId: `conversation-${index}`,
    languageGroup, split: 'holdout', query: `Query ${index}`, sourceScope: 'isolated-scoring-test', expectedIds: [`id-${index}`],
    expectedDisposition: 'retrieve', reviewer: 'unit-test', approvedAt: '2026-10-14T00:00:00Z' }));
  return { schemaVersion: '1', snapshot: { sourceRevision: 'test', modelRevision: 'test', configRevision: 'test', principalRef: 'test' },
    policy: { minLabelsPerBlock: 6, k: 1, margin: 0.02, alpha: 0.05 }, labels,
    observations: labels.flatMap(label => ['on', 'off'].map(mode => ({ caseId: label.caseId, runId: 'run-1', mode,
      candidateIds: [...label.expectedIds], rankedIds: [...label.expectedIds], disposition: 'retrieve', latencyMs: 10,
      embeddingCalls: mode === 'on' ? 1 : 0, qdrantCalls: 0,
      safety: { permission: 'passed', injection: 'passed', noFabrication: 'passed' } }))) };
}
test('perfect tiny samples stay inconclusive; absent blocks have null metrics', () => {
  const report = evaluate(input());
  assert.equal(report.blocks[0].status, 'inconclusive');
  assert.equal(report.blocks[0].off.recallAtK, 1);
  assert.equal(report.blocks[0].off.meanTokens, null);
  assert.equal(report.blocks[1].status, 'not_ready');
  assert.equal(report.blocks[1].on.recallAtK, null);
  assert.ok(report.defaultConfigurationDecision.startsWith('unchanged'));
});
test('candidate recall includes E4 events outside the retrieval window', () => {
  const value = input('E4');
  value.observations[0].candidateIds = [];
  value.observations[0].rankedIds = [];
  const row = evaluate(value).blocks[3].details[0];
  assert.equal(row.candidateRecall, 0); assert.equal(row.recallAtK, 0);
});
test('ranking loss is distinct from missing candidates', () => {
  const value = input();
  value.observations[0].candidateIds.push('distractor');
  value.observations[0].rankedIds = ['distractor', 'id-0'];
  const row = evaluate(value).blocks[0].details[0];
  assert.equal(row.candidateRecall, 1); assert.equal(row.recallAtK, 0);
});
test('unapproved labels, missing pairs and missing groups prevent readiness', () => {
  const value = input(); value.labels[0].approvedAt = null;
  value.observations.pop();
  const result = evaluate(value).blocks[0];
  assert.equal(result.status, 'not_ready');
  assert.ok(result.reasons.includes('ON_OFF_PAIR_MISSING'));
  assert.ok(result.missingGroups.includes('accented'));
});
test('OFF vector calls and unchecked safety cannot pass', () => {
  const value = input(); value.observations[1].embeddingCalls = 1;
  value.observations[0].safety.permission = 'not_checked';
  const result = evaluate(value).blocks[0];
  assert.equal(result.status, 'not_ready');
  assert.ok(result.reasons.includes('OFF_VECTOR_CALL_DETECTED'));
  assert.ok(result.reasons.includes('SAFETY_NOT_PASSED'));
});
test('repeated runs do not become independent conversation groups', () => {
  const value = input();
  value.labels.forEach(label => { label.groupId = 'same-conversation'; });
  value.observations.push(...structuredClone(value.observations).map(row => ({ ...row, runId: 'run-2' })));
  assert.equal(evaluate(value).blocks[0].intervals.recallAtK.independentGroups, 1);
});
test('split leakage, duplicates and impossible rankings are rejected', () => {
  const leaked = input(); leaked.labels[1].groupId = leaked.labels[0].groupId; leaked.labels[1].split = 'dev';
  assert.throws(() => evaluate(leaked), /SPLIT_LEAKAGE/);
  const duplicate = input(); duplicate.observations.push(duplicate.observations[0]);
  assert.throws(() => evaluate(duplicate), /DUPLICATE_OBSERVATION/);
  const invalid = input(); invalid.observations[0].rankedIds = ['not-a-candidate'];
  assert.throws(() => evaluate(invalid), /RANK_OUTSIDE_CANDIDATES/);
});
test('no-match labels are scored separately from recall', () => {
  const value = input();
  value.labels[0].expectedIds = []; value.labels[0].expectedDisposition = 'no_match';
  for (const row of value.observations.filter(row => row.caseId === 'case-0')) {
    row.candidateIds = []; row.rankedIds = []; row.disposition = 'no_match';
  }
  const details = evaluate(value).blocks[0].details;
  assert.equal(details[0].candidateRecall, null);
  assert.equal(details[0].dispositionCorrect, true);
});

test('legacy history becomes unapproved drafts without inventing observations or language labels', () => {
  const { prepare } = require('../scripts/prepare_retrieval_review');
  const prepared = prepare({ owner: 'test-owner', definitions: [], cases: [
    { id: 'a', sessionId: 'session', question: 'first' }, { id: 'b', sessionId: 'session', question: 'second' }
  ] }, { labels: [{ question: 'first', route: 'workflow', workflowId: 'workflow-id' }, { question: 'second', route: 'chat' }] });
  assert.equal(prepared.summary.approved, 0);
  assert.equal(prepared.input.labels[0].languageGroup, null);
  assert.equal(prepared.input.labels[0].split, prepared.input.labels[1].split);
  assert.equal(prepared.input.observations.length, 0);
  assert.equal(evaluate(prepared.input).blocks[2].status, 'not_ready');
  const value = input(); value.labels[0].reviewer = null;
  assert.throws(() => evaluate(value), /APPROVAL_METADATA_MISSING/);
});
