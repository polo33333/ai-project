'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, releaseGate, feedbackCases } = require('../src/backend/governance/operations');
test('operations distinguish missing usage/prices from zero cost and omit business content', () => {
  const report = summarize([{ status: 'PARTIAL', latencyMs: 100, question: 'private', requestPayload: {
    answerEnvelope: { requestAssessment: { complete: false } } } }]);
  assert.equal(report.missingCriteria, 1); assert.equal(report.cost.total, null);
  assert.equal(report.latency.p95Ms, 100); assert.equal(JSON.stringify(report).includes('private'), false);
});
test('managed pricing uses integer microUSD and thresholds generate observable alerts', () => {
  const policy = { revision: '1', pricingRevision: 'reviewed-1', rates: { test: { inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 2000000 } },
    thresholds: { minRequests: 1, errorRate: 0, p95Ms: 10, maxCostMicros: '1' } };
  const report = summarize([{ status: 'ERROR', modelName: 'test', latencyMs: 20,
    requestPayload: { tokenUsage: { available: true, inputTokens: 2, outputTokens: 3 } } }], policy);
  assert.equal(report.cost.total, '8');
  assert.deepEqual(report.alerts.map(item => item.code), ['ERROR_RATE_HIGH', 'LATENCY_P95_HIGH', 'COST_BUDGET_EXCEEDED']);
});
test('release stays on hold until quality, channels, security and rollback pass', () => {
  assert.equal(releaseGate({ checks: { tests: 'passed' }, previousRevision: 'old', candidateRevision: 'new' }).decision, 'hold');
  const checks = Object.fromEntries(['tests', 'businessRegression', 'permissions', 'injection', 'noFabrication', 'channelAcceptance', 'rollbackVerified'].map(name => [name, 'passed']));
  const release = releaseGate({ checks, previousRevision: 'old', candidateRevision: 'new' });
  assert.equal(release.decision, 'canary_eligible');
  assert.equal(release.automaticDeployment, false); assert.ok(release.preserve.includes('permissions'));
});
test('approved feedback needs an explicit expected outcome before becoming regression', () => {
  const feedback = [{ id: 'f', auditId: 'a', reviewStatus: 'approved', reviewedAt: '2026-10-14' }];
  const audits = [{ id: 'a', question: 'question', replyText: 'unverified answer' }];
  assert.equal(feedbackCases(feedback, audits).cases.length, 0);
  feedback[0].reviewExpectedOutcome = 'Require fresh source evidence';
  feedback[0].reviewedBy = 'reviewer';
  const result = feedbackCases(feedback, audits);
  assert.equal(result.cases[0].expectedOutcome, 'Require fresh source evidence');
  assert.equal(JSON.stringify(result).includes('unverified answer'), false);
});

test('operations endpoint is admin-only and never returns prompts', async t => {
  const logger = require('../src/backend/services/logger_service');
  t.mock.property(logger, 'chatHistory', [{ status: 'SUCCESS', question: 'private prompt', latencyMs: 1 }]);
  const routes = require('../src/backend/governance/routes');
  let status, body;
  const response = { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } };
  await routes.handle({ method: 'GET' }, response, '/api/governance/operations', { role: 'user' }, async () => ({}));
  assert.equal(status, 403);
  await routes.handle({ method: 'GET' }, response, '/api/governance/operations', { role: 'admin' }, async () => ({}));
  assert.equal(status, 200); assert.equal(body.requests, 1);
  assert.equal(JSON.stringify(body).includes('private prompt'), false);
});
