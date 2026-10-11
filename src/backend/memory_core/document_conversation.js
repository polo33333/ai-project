'use strict';

const { isValid } = require('./reference_store');
const policy = require('./memory_policy');
const normalize = require('../utils/lexical_normalize');

function scopeKey(scope) { return `${scope.mode}:${[...scope.documentIds].sort().join(',')}`; }

const DOCUMENT_NOUN = /\b(?:tai lieu|tl|file|tep|van ban|vb)\b/;
const DOCUMENT_REFERENCE = /\b(?:tai lieu|tl|file|tep|van ban|vb)\s+(?:tren|do|nay|vua (?:roi|neu)|thu (?:\d+|nhat|hai|ba|tu|nam))\b/;
function hasContextReference(question) {
  // "Dựa trên kho tri thức" and "cài trên Android" use trên as a
  // preposition, not as an antecedent. Keep explicit noun references instead.
  return DOCUMENT_REFERENCE.test(normalize(question))
    || /\b(?:muc|buoc|phan|ket qua|giay to|quy dinh)\s+tren\b/.test(normalize(question))
    || policy.hasReferencePronoun(String(question).replace(/\b(?:trên|tren)\b/giu, ' '));
}
function isPageCountQuestion(question) {
  return /(?:may|bao nhieu|so(?: luong)?)\s+trang\b/.test(normalize(question));
}
function isDocumentFollowup(question) {
  const text = normalize(question);
  return DOCUMENT_REFERENCE.test(text)
    || (isPageCountQuestion(question) && (hasContextReference(question)
      || DOCUMENT_NOUN.test(text) || /^(?:con |vay |the |co )?(?:may|bao nhieu|so(?: luong)?)\s+trang\b/.test(text)));
}

// Only explicit numbered items in the displayed reply establish ordinal references.
// Separate numbered lists are deliberately retained as competing antecedents.
function displayedLists(reply, evidence) {
  const lists = [];
  let list = null;
  for (const line of String(reply).split('\n')) {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (!match) { if (line.trim()) list = null; continue; }
    if (!list || Number(match[1]) === 1) { list = []; lists.push(list); }
    const ids = [...match[2].matchAll(/\[(\d+)\]/g)].flatMap(marker => {
      const hit = evidence.find(item => item.citationIndex === Number(marker[1]));
      return hit ? [hit.payload?.chunkId || `${hit.payload.documentId}:${hit.payload.chunkIndex}`] : [];
    });
    list.push({ ordinal: Number(match[1]), text: match[2].slice(0, 700), evidenceIds: ids });
  }
  return lists.slice(0, 5).map(list => list.slice(0, 50));
}

function createState({ question, reply, evidence, scope, accountId = null, now = Date.now() }) {
  const markers = new Set([...String(reply).matchAll(/\[(\d+)\](?!\s*\()/g)].map(match => Number(match[1])));
  const citedEvidence = [...markers].flatMap(marker => evidence.filter(hit => Number(hit.citationIndex) === marker));
  return { accountId, scope: scopeKey(scope), question: String(question).slice(0, 1500),
    updatedAt: new Date(now).toISOString(), lists: displayedLists(reply, evidence),
    sources: [...new Map(citedEvidence.map(hit => [hit.payload.documentId,
      { documentId: String(hit.payload.documentId), title: hit.payload.title || '', revision: hit.payload.revision || null }])).values()],
    evidenceIds: citedEvidence.map(hit => hit.payload.chunkId || `${hit.payload.documentId}:${hit.payload.chunkIndex}`) };
}

function resolve(question, { state, scope, documents, accountId = null, now = Date.now() }) {
  const normalized = normalize(question);
  const ordinal = normalized.match(/(?:(?:cai|muc|buoc|phan|dieu|tai lieu|tl|file|tep|van ban|vb)\s+thu\s+|cai\s+)(\d+|nhat|hai|ba|tu|nam)\b/);
  const contextual = Boolean(ordinal || isPageCountQuestion(question) || hasContextReference(question)
    || /^(?:con|the con|neu vay|vay thi|tiep tuc)\b/.test(normalized));
  const result = { resolvedQuery: question, referencedEvidenceIds: [], ambiguities: [], resolutionMethod: 'original' };
  if (!contextual) return result;
  const available = new Map(documents.map(document => [String(document.id), document.revision || null]));
  if (!policy.isEnabled() || !isValid(state, now) || state.accountId !== accountId || state.scope !== scopeKey(scope)
      || !state.sources.length || state.sources.some(source => !scope.documentIds.includes(source.documentId)
        || !available.has(source.documentId) || available.get(source.documentId) !== source.revision)) {
    return { ...result, ambiguities: ['missing_or_stale_reference'], resolutionMethod: 'clarify' };
  }
  let antecedent = state.question;
  const documentReference = DOCUMENT_NOUN.test(normalized) || isPageCountQuestion(question);
  if (documentReference) {
    const number = ordinal && (Number(ordinal[1]) || ({ nhat: 1, hai: 2, ba: 3, tu: 4, nam: 5 })[ordinal[1]]);
    const candidates = number ? state.sources.slice(number - 1, number) : state.sources;
    if (candidates.length !== 1) return { ...result, ambiguities: ['ambiguous_document'], resolutionMethod: 'clarify' };
    const source = candidates[0];
    const document = documents.find(item => String(item.id) === source.documentId);
    antecedent = document.title || source.title || state.question;
    result.referencedDocumentIds = [source.documentId];
    result.referencedEvidenceIds = state.evidenceIds.filter(id => id.startsWith(`${source.documentId}:`));
  } else if (ordinal) {
    const number = Number(ordinal[1]) || ({ nhat: 1, hai: 2, ba: 3, tu: 4, nam: 5 })[ordinal[1]];
    const candidates = state.lists.flatMap(list => list.filter(item => item.ordinal === number));
    if (candidates.length !== 1 || !candidates[0].evidenceIds.length) {
      return { ...result, ambiguities: ['ambiguous_ordinal'], resolutionMethod: 'clarify' };
    }
    antecedent = candidates[0].text;
    result.referencedEvidenceIds = candidates[0].evidenceIds;
  } else if (hasContextReference(question)) {
    // A pronoun without a displayed, evidence-linked singleton is ambiguous.
    const candidates = state.lists.flat();
    if (candidates.length !== 1 || !candidates[0].evidenceIds.length) {
      return { ...result, ambiguities: ['ambiguous_pronoun'], resolutionMethod: 'clarify' };
    }
    antecedent = candidates[0].text;
    result.referencedEvidenceIds = candidates[0].evidenceIds;
  } else result.referencedEvidenceIds = state.evidenceIds;
  return { ...result, resolvedQuery: `${question}\nNgữ cảnh tham chiếu: ${antecedent}`, resolutionMethod: 'deterministic' };
}

module.exports = { createState, resolve, scopeKey, isDocumentFollowup, isPageCountQuestion };
