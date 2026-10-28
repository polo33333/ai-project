'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMetrics, parseTime } = require('../src/backend/training/pipeline_metrics');
const { selectCandidates, promote } = require('../src/backend/training/golden_candidates');

const usage = (stage, inputTokens, cachedInputTokens = 0) => ({ type: 'MODEL_USAGE', stage, calls: 1, inputTokens, cachedInputTokens });
const record = (id, timestamp, status, diagnostics = {}, extra = {}) => ({ id, timestamp, status, question: `q-${id}`, replyText: `r-${id}`, latencyMs: 1000,
  requestPayload: { endpoint: '/api/intelligent-core/chat/stream', sessionId: extra.sessionId || `s-${id}`, tokenUsage: { inputTokens: 100, outputTokens: 10 },
    memoryDecision: extra.memoryDecision, diagnostics } , ...extra.record });

test('audit timestamps in local and ISO form are parsed', () => {
  assert.equal(parseTime('21:52:42 25/10/2026').getDate(), 25);
  assert.equal(parseTime('2026-10-25T14:52:42.000Z').toISOString(), '2026-10-25T14:52:42.000Z');
  assert.equal(parseTime('not a date'), null);
});

test('metrics separate v2 answers, v2 fallbacks and older routes, and skip evaluation sessions', () => {
  const history = [
    record('a', '08:00:00 20/10/2026', 'SUCCESS'),
    record('b', '08:00:00 24/10/2026', 'SUCCESS', { pipeline: 'v2', executionBudget: { modelCalls: 1 }, steps: [usage('v2_contract', 100, 60)] }),
    record('c', '09:00:00 24/10/2026', 'PARTIAL', { pipeline: 'v2', responseEvaluation: { failures: ['V2_CLARIFY'] }, executionBudget: { modelCalls: 1 }, steps: [usage('v2_contract', 100)] }),
    record('d', '10:00:00 24/10/2026', 'SUCCESS', { harness: 'provider_guarded', v2Attempt: { fallbackCode: 'V2_CONTRACT_INVALID' }, executionBudget: { modelCalls: 5 } }),
    record('e', '11:00:00 24/10/2026', 'SUCCESS', { pipeline: 'v2' }, { sessionId: 'eval-run-1' })
  ];
  const metrics = computeMetrics(history);
  assert.equal(metrics.overall.total, 4);
  assert.equal(metrics.window.firstV2.slice(0, 10), '2026-10-24');
  assert.equal(metrics.v2Era.total, 3);
  assert.equal(metrics.v2Era.deterministicShare, 0.667);
  assert.equal(metrics.v2Era.fallbackShare, 0.333);
  assert.equal(metrics.v2Era.clarifyRate, 0.333);
  assert.deepEqual(metrics.fallbackCodes, [{ name: 'V2_CONTRACT_INVALID', count: 1 }]);
  assert.equal(metrics.overall.cache.cachedInputTokens, 60);
  assert.deepEqual(metrics.routes.map(item => item.name).sort(), ['legacy', 'v2', 'v2_fallback']);
  assert.equal(metrics.daily.length, 2);
});

test('labelling candidates skip known cases and retries, pair follow-ups, and put struggling turns first', () => {
  const followup = { mode: 'reference' };
  const history = [
    record('1', '08:00:00 24/10/2026', 'SUCCESS', {}, { sessionId: 's1' }),
    record('2', '08:01:00 24/10/2026', 'PARTIAL', { v2Attempt: { fallbackCode: 'X' } }, { sessionId: 's1', memoryDecision: followup }),
    record('3', '08:02:00 24/10/2026', 'SUCCESS', {}, { sessionId: 's1', memoryDecision: followup, record: { question: 'q-2' } }),
    record('4', '08:03:00 24/10/2026', 'SUCCESS', {}, { sessionId: 's2', record: { question: 'ds nv' } }),
    record('5', '08:04:00 24/10/2026', 'ERROR', {}, { sessionId: 's3' })
  ];
  const candidates = selectCandidates(history, { existingCases: [{ turns: ['ds nv'] }], feedback: [{ auditId: '1', rating: 'dislike' }] });
  // The follow-up that fell back and stayed PARTIAL comes first; its retry adds nothing.
  assert.deepEqual(candidates.map(item => item.turns), [['q-1', 'q-2'], ['q-1']]);
  assert.equal(candidates[1].observed.rating, 'dislike');
  assert.ok(candidates.every(item => item.accept === null && !item.must.length));
});

test('only accepted candidates with checks are promoted, without duplicates', () => {
  const fixture = { cases: [{ id: 'old', turns: ['ds nv'], must: ['NV001'] }] };
  const result = promote(fixture, [
    { id: 'new', group: 'list', turns: ['danh sách khách hàng'], accept: true, must: ['KA0021'], mustNot: [], mustTools: [] },
    { id: 'unlabelled', turns: ['x'], accept: true, must: [] },
    { id: 'rejected', turns: ['y'], accept: false, must: ['a'] },
    { id: 'dup', turns: ['DS  NV'], accept: true, must: ['a'] }
  ]);
  assert.deepEqual(result.added, ['new']);
  assert.deepEqual(result.skipped, [{ id: 'unlabelled', reason: 'no_checks' }, { id: 'dup', reason: 'duplicate_turns' }]);
  assert.deepEqual(fixture.cases.at(-1), { id: 'new', group: 'list', turns: ['danh sách khách hàng'], must: ['KA0021'] });
});
