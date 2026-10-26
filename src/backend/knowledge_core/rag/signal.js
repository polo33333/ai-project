'use strict';

// Document signal for routing: how strongly a question points at the document
// library, without a model call (one local embedding). Strong when the
// question names a library file, addresses the library ("theo tài liệu", "kho
// tri thức"), or its best passage scores above RAG_ROUTING_MIN_SCORE.
// Measured with npm run eval:routing; see the routing plan of 26/10/2026.
//
// The search covers every document the user may read, so the signal also says
// when the best match is a document the current model may not receive
// (`blocked`): the user is then told so instead of getting "not in the documents".
const normalize = require('../../utils/lexical_normalize');
const libraryService = require('../services/library_service');
const qdrantService = require('../../services/qdrant_service');
const { namedDocuments, stripCommand } = require('./query');

const EXPLICIT = /\b(?:theo|trong|tu|dua (?:tren|vao)) (?:cac )?(?:tai lieu|van ban|huong dan su dung)\b|\btai lieu huong dan\b|\bkho (?:tri thuc|tai lieu)\b|\bthu vien tai lieu\b/;
const DEFAULT_MIN_SCORE = 0.6;

function minScore() {
  const value = Number(process.env.RAG_ROUTING_MIN_SCORE);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : DEFAULT_MIN_SCORE;
}

// Documents the user may read and the current model may receive.
function routableDocuments(modelDestination = null) {
  const governance = require('../../governance/context');
  return libraryService.getDocuments().filter(document => !modelDestination
    || governance.canSend(document, modelDestination.id, modelDestination.local));
}

// Readable documents the current model may not receive.
function blockedDocuments(modelDestination = null) {
  if (!modelDestination) return [];
  const allowed = new Set(routableDocuments(modelDestination).map(document => String(document.id)));
  return libraryService.getDocuments().filter(document => !allowed.has(String(document.id)));
}

const describe = document => ({ documentId: String(document.id), title: document.title,
  sensitivity: document.governedPolicy?.sensitivity || 'internal' });

async function documentSignal(question, { modelDestination = null, documents = null, blocked = null, threshold = minScore() } = {}) {
  const library = documents || routableDocuments(modelDestination);
  const withheld = blocked || (documents ? [] : blockedDocuments(modelDestination));
  if (!library.length && !withheld.length) return { strength: 'none', reason: 'no_documents', score: null, blocked: null };
  const text = String(question || '');
  const allowedIds = new Set(library.map(document => String(document.id)));
  const explicit = EXPLICIT.test(normalize(text)) || stripCommand(text) !== text.trim();
  const named = namedDocuments(text, library);
  let score = null, documentId = null, vectorStatus = 'disabled', results = [];
  if (require('../../services/embedding_policy').enabled()) {
    const vector = await qdrantService.searchDocuments(text, 5, { documentIds: [...library, ...withheld].map(document => String(document.id)), detailed: true });
    vectorStatus = vector.status;
    results = (vector.results || []).map(hit => ({ score: Number(Number(hit.score).toFixed(3)), documentId: String(hit.payload?.documentId || '') }));
    const top = results.find(hit => allowedIds.has(hit.documentId));
    if (top) ({ score, documentId } = top);
  }
  const reason = !library.length ? null : named.length ? 'file_name' : explicit ? 'explicit' : score !== null && score >= threshold ? 'score' : null;
  const top = named[0] || library.find(document => String(document.id) === documentId) || null;
  // Blocked: the question names a withheld file, or the best passage overall is in a withheld document.
  const namedBlocked = namedDocuments(text, withheld);
  const best = results[0];
  const blockedHits = !named.length && best && !allowedIds.has(best.documentId) && best.score >= threshold
    ? [...new Set(results.filter(hit => !allowedIds.has(hit.documentId) && hit.score >= threshold).map(hit => hit.documentId))] : [];
  const blockedList = namedBlocked.length ? namedBlocked
    : blockedHits.map(id => withheld.find(document => String(document.id) === id)).filter(Boolean);
  return { strength: library.length ? (reason ? 'strong' : 'weak') : 'none', reason: reason || (library.length ? 'below_threshold' : 'no_documents'),
    score, threshold, vectorStatus, documentId: top ? String(top.id) : null, title: top?.title || null,
    blocked: blockedList.length ? { reason: namedBlocked.length ? 'file_name' : 'score', score: namedBlocked.length ? null : best.score,
      documents: blockedList.slice(0, 3).map(describe) } : null };
}

module.exports = { documentSignal, routableDocuments, blockedDocuments, minScore, EXPLICIT };
