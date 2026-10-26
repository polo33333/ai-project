'use strict';

// Scores document retrieval against tests/fixtures/retrieval_golden.json.
// A returned chunk is relevant when it belongs to the expected document and
// contains one evidence phrase. Phrases are compared without accents, spaces
// or punctuation so re-chunking and broken PDF spacing do not move answers.
const normalize = require('../../src/backend/utils/lexical_normalize');

const key = value => normalize(value).replace(/[^a-z0-9]/g, '');
const CUTOFFS = [1, 3, 5];

function validateFixture(fixture) {
  const cases = fixture?.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error('RETRIEVAL_GOLDEN_FIXTURE_EMPTY');
  const ids = new Set();
  for (const item of cases) {
    if (!item.id || !item.query || ids.has(item.id)) throw new Error(`RETRIEVAL_GOLDEN_CASE_INVALID: ${item.id || item.query}`);
    ids.add(item.id);
    if (item.expect && !item.expect.documentId) throw new Error(`RETRIEVAL_GOLDEN_CASE_INVALID: ${item.id}`);
    if (/replace-with|placeholder/i.test(String(item.expect?.documentId || ''))) throw new Error('RETRIEVAL_GOLDEN_FIXTURE_PLACEHOLDER');
  }
  return cases;
}

function isRelevant(expect, payload = {}) {
  if (!expect || String(payload.documentId) !== String(expect.documentId)) return false;
  if (!expect.evidence?.length) return true;
  const text = key(payload.fullText || payload.text || '');
  return expect.evidence.some(phrase => text.includes(key(phrase)));
}

// results: ranked hits with payload { documentId, fullText }.
function scoreCase(item, results = []) {
  const rank = item.expect ? results.findIndex(hit => isRelevant(item.expect, hit.payload)) + 1 : 0;
  return { id: item.id, category: item.category, rank: rank || null,
    topDocumentId: results[0]?.payload?.documentId || null,
    documentHitAt1: item.expect ? String(results[0]?.payload?.documentId) === String(item.expect.documentId) : null,
    returned: results.slice(0, 5).map(hit => `${hit.payload?.documentId}:${hit.payload?.chunkIndex}`) };
}

function aggregate(rows) {
  const answerable = rows.filter(row => row.documentHitAt1 !== null);
  const share = predicate => answerable.length ? answerable.filter(predicate).length / answerable.length : null;
  return { cases: answerable.length,
    ...Object.fromEntries(CUTOFFS.map(k => [`recallAt${k}`, share(row => row.rank && row.rank <= k)])),
    mrrAt10: answerable.length ? answerable.reduce((sum, row) => sum + (row.rank && row.rank <= 10 ? 1 / row.rank : 0), 0) / answerable.length : null,
    documentHitAt1: share(row => row.documentHitAt1) };
}

function summarize(rows) {
  const categories = [...new Set(rows.map(row => row.category))];
  return { overall: aggregate(rows),
    byCategory: Object.fromEntries(categories.map(category => [category, aggregate(rows.filter(row => row.category === category))])),
    misses: rows.filter(row => row.documentHitAt1 !== null && !(row.rank && row.rank <= 5)).map(row => row.id) };
}

module.exports = { key, isRelevant, scoreCase, summarize, validateFixture };
