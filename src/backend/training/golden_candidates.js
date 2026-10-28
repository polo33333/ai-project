'use strict';

// Candidate questions for the live evaluation set (tests/fixtures/live_eval_cases.json),
// taken from real chat turns. A person labels each candidate (accept, must,
// mustNot, mustTools) from the source data; only labelled, accepted candidates
// are promoted. Nothing here decides what a correct answer is.
const crypto = require('node:crypto');
const { toRow } = require('./pipeline_metrics');

const fold = value => String(value || '').normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const FOLLOWUP_WINDOW_MS = 30 * 60000;

function caseGroup(row) {
  if (row.contractKind && row.contractKind !== 'data') return row.contractKind;
  return row.operation || row.route;
}

function selectCandidates(history = [], { existingCases = [], feedback = [], limit = 120, perGroup = 15, excludeSessionPrefixes = ['eval-'] } = {}) {
  const known = new Set(existingCases.flatMap(item => item.turns || []).map(fold));
  const ratings = new Map(feedback.map(item => [item.auditId, item.rating]));
  const rows = history.map(record => ({ record, row: toRow(record) }))
    .filter(({ row }) => row.time && !excludeSessionPrefixes.some(prefix => String(row.sessionId || '').startsWith(prefix)))
    .sort((a, b) => a.row.time - b.row.time);
  const previousInSession = new Map();
  const seen = new Set();
  const candidates = [];
  for (const { record, row } of rows) {
    const question = String(record.question || '').trim();
    const previous = row.sessionId ? previousInSession.get(row.sessionId) : null;
    if (!question || row.status === 'ERROR' || question.length > 500) continue;
    const memory = record.requestPayload?.memoryDecision;
    const followup = Boolean(previous && fold(previous.question) !== fold(question) && row.time - previous.time <= FOLLOWUP_WINDOW_MS
      && memory && memory.mode && memory.mode !== 'none');
    // A repeated question is a retry of the previous turn, with its context.
    const turns = previous && fold(previous.question) === fold(question) ? previous.turns
      : followup ? [previous.question, question] : [question];
    if (row.sessionId) previousInSession.set(row.sessionId, { question, time: row.time, turns });
    const key = turns.map(fold).join(' >> ');
    if (seen.has(key) || (!followup && known.has(fold(question)))) continue;
    seen.add(key);
    const rating = ratings.get(record.id) || null;
    // Questions the system struggled with are worth labelling first.
    const priority = (rating === 'dislike' ? 4 : 0) + (row.status === 'PARTIAL' ? 2 : 0)
      + (row.route === 'v2_fallback' ? 2 : 0) + (followup ? 1 : 0) + (/\d/.test(question) ? 1 : 0);
    candidates.push({ id: `cand-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 10)}`, group: caseGroup(row), turns,
      accept: null, must: [], mustNot: [], mustTools: [], note: '',
      observed: { auditId: record.id, at: row.time.toISOString(), status: row.status, route: row.route, rating,
        provider: row.provider, failures: row.failures, reply: String(record.replyText || '').slice(0, 600) },
      priority });
  }
  const perGroupCount = new Map();
  return candidates.sort((a, b) => b.priority - a.priority || b.observed.at.localeCompare(a.observed.at))
    .filter(item => {
      const count = perGroupCount.get(item.group) || 0;
      if (count >= perGroup) return false;
      perGroupCount.set(item.group, count + 1);
      return true;
    }).slice(0, limit);
}

// Accepted candidates with at least one check become fixture cases.
function promote(fixture, candidates) {
  const ids = new Set(fixture.cases.map(item => item.id));
  const turns = new Set(fixture.cases.map(item => item.turns.map(fold).join(' >> ')));
  const added = [], skipped = [];
  for (const item of candidates) {
    if (item.accept !== true) continue;
    const id = String(item.id || '').trim();
    const key = (item.turns || []).map(fold).join(' >> ');
    const checks = [...(item.must || []), ...(item.mustNot || []), ...(item.mustTools || [])];
    const reason = !id ? 'missing_id' : ids.has(id) ? 'duplicate_id' : turns.has(key) ? 'duplicate_turns'
      : !Array.isArray(item.turns) || !item.turns.length ? 'missing_turns' : !checks.length ? 'no_checks' : null;
    if (reason) { skipped.push({ id: id || null, reason }); continue; }
    const testCase = { id, group: item.group || 'other', turns: item.turns, must: item.must || [],
      ...(item.mustNot?.length ? { mustNot: item.mustNot } : {}), ...(item.mustTools?.length ? { mustTools: item.mustTools } : {}),
      ...(item.note ? { note: item.note } : {}) };
    fixture.cases.push(testCase);
    ids.add(id); turns.add(key); added.push(id);
  }
  return { fixture, added, skipped };
}

module.exports = { selectCandidates, promote };
