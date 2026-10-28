'use strict';

// One document RAG service for every path (v2 document answer, the agent
// loop's search tool, selected documents in core.js):
//   understand question -> retrieve (vector + BM25, RRF) -> rank -> pack -> answer (caller) -> verify.
// See docs/RAG_REVIEW_261026.html; eval: npm run eval:retrieval.
const retrievalService = require('../services/retrieval_service');
const libraryService = require('../services/library_service');
const { understand } = require('./query');
const { verifyClaims } = require('./verify');
const { isValid } = require('../../memory/reference_store');

async function retrieve({ question, previous = null, documentIds = [], scopeMode = null, limit = 6 }) {
  const scope = retrievalService.resolveScope(documentIds, scopeMode);
  const allowed = new Set(scope.documentIds);
  const understanding = understand({ question, previous,
    documents: libraryService.getDocuments().filter(document => allowed.has(String(document.id))) });
  const retrieval = await retrievalService.search(understanding.searchQuery, understanding.documentIds.length
    ? { limit, documentIds: understanding.documentIds, scopeMode: 'selected' } : { limit, documentIds, scopeMode });
  return { ...retrieval, scope, understanding };
}

// A short passage is read together with its neighbours of the same section, so
// an idea split across chunks reaches the model whole. Table rows stand alone.
function expandNeighbours(results, { shortChars = 400, maxChars = 1200 } = {}) {
  const taken = new Set(results.map(hit => `${hit.payload?.documentId}:${hit.payload?.chunkIndex}`));
  return results.map(hit => {
    const payload = hit.payload || {};
    let text = String(payload.fullText || '');
    if (text.length >= shortChars || payload.rowStart || !Number.isInteger(Number(payload.chunkIndex))) return hit;
    let chunks;
    try { chunks = libraryService.getChunks(payload.documentId); } catch (_) { return hit; }
    const added = [];
    for (const index of [Number(payload.chunkIndex) + 1, Number(payload.chunkIndex) - 1]) {
      const neighbour = chunks.find(chunk => chunk.chunkIndex === index);
      const id = `${payload.documentId}:${index}`;
      if (!neighbour || taken.has(id) || (neighbour.section || null) !== (payload.section || null)
        || (neighbour.page || null) !== (payload.page || null) || text.length + neighbour.text.length > maxChars) continue;
      text = index > payload.chunkIndex ? `${text}\n${neighbour.text}` : `${neighbour.text}\n${text}`;
      taken.add(id);
      added.push(index);
    }
    return added.length ? { ...hit, payload: { ...payload, fullText: text, expandedWith: added } } : hit;
  });
}

function pack(results, tokenBudget = Number(process.env.AI_DOCUMENT_CONTEXT_TOKENS || 3000)) {
  return retrievalService.packContext(expandNeighbours(results), tokenBudget);
}

// The document state saved after a cited answer, as the previous turn for retrieve().
function previousFromState(state, { accountId = null, now = Date.now() } = {}) {
  if (!state?.sources?.length || !isValid(state, now) || (state.accountId || null) !== (accountId || null)) return null;
  return { question: state.question, documentIds: state.sources.map(source => String(source.documentId)) };
}

// Compact trace of one retrieval for diagnostics and pipeline metrics.
function summarize(retrieval, packed = null) {
  return { mode: retrieval.mode, vectorStatus: retrieval.vectorStatus || null, degraded: /_degraded$/.test(retrieval.mode || ''),
    rerankFallback: Boolean(retrieval.rerankFallback), method: retrieval.understanding?.method || 'original',
    scopedDocuments: retrieval.understanding?.documentIds?.length || 0, found: retrieval.results?.length || 0,
    ...(packed ? { packed: packed.selected.length, droppedByBudget: packed.dropped, contextTokens: packed.usedTokens } : {}) };
}

module.exports = { retrieve, pack, expandNeighbours, previousFromState, summarize, verifyClaims };
