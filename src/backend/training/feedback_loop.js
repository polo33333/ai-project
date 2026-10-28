'use strict';

// Feedback learning loop. Rated or reviewed chat turns become drafts:
//   - a disliked / "xem lại" answer -> a regression case for the live
//     evaluation set, plus an example contract when the user re-asked in the
//     same session and the re-ask was answered by v2;
//   - a liked / "đạt" v2 data answer -> an example of a verified contract.
// A person accepts each draft (accept=true, edits must/example). Accepted
// examples are stored on the data source and offered to the v2 planner for
// similar questions, but only while they still compile against the current
// catalog; nothing here decides by itself what a correct answer is.
const crypto = require('node:crypto');
const { toRow } = require('./pipeline_metrics');

const fold = value => String(value || '').normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const REASK_WINDOW_MS = 30 * 60000;
const MAX_EXAMPLES = 200;
const BAD = new Set(['dislike']), GOOD = new Set(['like']);

// Words of a question without values: codes, numbers and dates differ between
// questions of the same shape ("của KA0021 tháng 2024-02").
function words(text) {
  return new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1 && !/\d/.test(word)));
}
function similarity(a, b) {
  const left = words(a), right = words(b);
  const shared = [...left].filter(word => right.has(word)).length;
  return shared ? shared / new Set([...left, ...right]).size : 0;
}

// Numbers stated in a reviewer's expected outcome, as live-eval checks.
function numberChecks(text) {
  return [...new Set((String(text || '').match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{2,}(?:,\d+)?/g) || [])
    .map(value => Number(value.replace(/\./g, '').replace(',', '.'))).filter(Number.isFinite))].map(num => ({ num }));
}

const contractOf = record => record.requestPayload?.diagnostics?.v2Contract || null;

function draftItems(history = [], feedback = [], { existingCases = [], examples = [], excludeSessionPrefixes = ['eval-'] } = {}) {
  const knownCases = new Set(existingCases.flatMap(item => item.turns || []).map(fold));
  const knownExamples = new Set(examples.map(item => fold(item.question)));
  const reviews = new Map(feedback.map(item => [item.auditId, item]));
  const rows = history.map(record => ({ record, row: toRow(record) }))
    .filter(({ row }) => row.time && !excludeSessionPrefixes.some(prefix => String(row.sessionId || '').startsWith(prefix)))
    .sort((a, b) => a.row.time - b.row.time);
  const items = [], seen = new Set();
  for (const [index, { record, row }] of rows.entries()) {
    const review = reviews.get(record.id);
    if (!review) continue;
    const question = String(record.question || '').trim();
    const bad = BAD.has(review.rating) || review.reviewStatus === 'needs_review';
    const good = !bad && (GOOD.has(review.rating) || review.reviewStatus === 'approved');
    if (!question || (!bad && !good) || seen.has(fold(question))) continue;
    seen.add(fold(question));
    const observedContract = contractOf(record);
    let example = null, correction = null;
    if (good && row.route === 'v2' && row.status === 'SUCCESS' && observedContract?.kind === 'data' && !observedContract.followup) {
      example = { question, contract: observedContract };
    } else if (bad) {
      // The user's own re-ask in the same session, answered by v2 and not disliked.
      correction = rows.slice(index + 1).find(({ record: later, row: next }) => next.sessionId && next.sessionId === row.sessionId
        && next.time - row.time <= REASK_WINDOW_MS && next.route === 'v2' && next.status === 'SUCCESS'
        && contractOf(later)?.kind === 'data' && !contractOf(later).followup && !BAD.has(reviews.get(later.id)?.rating)
        && similarity(later.question, question) >= 0.3) || null;
      if (correction) example = { question, contract: contractOf(correction.record), from: correction.record.id };
    }
    if (example && knownExamples.has(fold(question))) example = null;
    const caseDraft = bad && !knownCases.has(fold(question))
      ? { must: numberChecks(review.reviewExpectedOutcome), mustNot: [], mustTools: [] } : null;
    if (!example && !caseDraft) continue;
    items.push({ id: `learn-${crypto.createHash('sha256').update(fold(question)).digest('hex').slice(0, 10)}`,
      kind: bad ? 'correction' : 'confirmed', accept: null, turns: [question], example, case: caseDraft, note: '',
      observed: { auditId: record.id, at: row.time.toISOString(), route: row.route, status: row.status, rating: review.rating || null,
        reviewStatus: review.reviewStatus || null, reviewNote: review.reviewNote || '', expectedOutcome: review.reviewExpectedOutcome || '',
        failures: row.failures, fallbackCode: row.fallbackCode, contract: observedContract, reply: String(record.replyText || '').slice(0, 600),
        ...(correction ? { reask: { auditId: correction.record.id, question: correction.record.question, reply: String(correction.record.replyText || '').slice(0, 600) } } : {}) } });
  }
  // Corrections first: they are what the system got wrong.
  return items.sort((a, b) => (a.kind === b.kind ? b.observed.at.localeCompare(a.observed.at) : a.kind === 'correction' ? -1 : 1));
}

// Accepted drafts: examples (valid v2 data contracts) and regression cases.
function promoteLearning(items, { examples = [], fixture = { cases: [] }, validateContract, now = new Date().toISOString() } = {}) {
  const stored = [...examples], known = new Set(stored.map(item => fold(item.question)));
  const added = { examples: [], cases: [] }, skipped = [];
  const cases = [];
  for (const item of items) {
    if (item.accept !== true) continue;
    if (item.example) {
      const question = String(item.example.question || item.turns?.[0] || '').trim();
      const contract = item.example.contract;
      const reason = !question ? 'missing_question' : known.has(fold(question)) ? 'duplicate_example'
        : contract?.kind !== 'data' || !contract.root ? 'not_data_contract' : validateContract && !validateContract(contract) ? 'invalid_contract' : null;
      if (reason) skipped.push({ id: item.id, reason });
      else {
        stored.push({ id: item.id, question, contract: structuredClone(contract), sourceAuditId: item.observed?.auditId || null, approvedAt: now });
        known.add(fold(question)); added.examples.push(item.id);
      }
    }
    if (item.case) cases.push({ id: item.id, group: 'feedback', turns: item.turns, accept: true, note: item.note,
      must: item.case.must || [], mustNot: item.case.mustNot || [], mustTools: item.case.mustTools || [] });
  }
  const promoted = require('./golden_candidates').promote(fixture, cases);
  added.cases = promoted.added;
  skipped.push(...promoted.skipped);
  // The newest examples are kept when the store is full.
  return { examples: stored.slice(-MAX_EXAMPLES), fixture: promoted.fixture, added, skipped };
}

// Accepted examples of the source, read like governed metrics.
function sourceExamples(dbSourceId) {
  try {
    const source = require('../governance/context').current()?.resources.get(`sql:${dbSourceId}`)?.resource
      || require('../services/sql_connector').dbSources.find(item => item.id === dbSourceId);
    return source?.learnedExamples || [];
  } catch { return []; }
}

// The most similar accepted examples whose contract still compiles against the
// catalog of this request (tables, columns and relationships may have changed).
function selectExamples(examples, question, catalog, { limit = 3, minScore = 0.3 } = {}) {
  const { compile } = require('../agent/pipeline/query_compiler');
  return examples.map(item => ({ item, score: similarity(item.question, question) }))
    .filter(({ score }) => score >= minScore).sort((a, b) => b.score - a.score)
    .filter(({ item }) => { try { compile(item.contract, catalog, { question: item.question }); return true; } catch { return false; } })
    .slice(0, limit).map(({ item, score }) => ({ id: item.id, question: item.question, contract: item.contract, score: +score.toFixed(2) }));
}

module.exports = { draftItems, promoteLearning, sourceExamples, selectExamples, similarity, numberChecks };
