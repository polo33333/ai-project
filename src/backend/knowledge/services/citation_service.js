const MAX_EXCERPT_CHARS = 520;

function locator(payload) {
  const label = [payload.page && `Trang ${payload.page}`, payload.sheet && `Sheet ${payload.sheet}`,
    payload.section, payload.rowStart && `Dòng ${payload.rowStart}–${payload.rowEnd}`].filter(Boolean).join(' · ');
  return { ...(label ? { locationLabel: label } : {}), ...Object.fromEntries(['page', 'sheet', 'section', 'rowStart', 'rowEnd', 'revision', 'chunkId']
    .filter(key => payload[key] !== null && payload[key] !== undefined).map(key => [key, payload[key]])) };
}

function normalizeExcerpt(value, maxChars = MAX_EXCERPT_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const shortened = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${shortened}…`;
}

const normalizeSearch = require('../../utils/lexical_normalize');
const searchTokens = value => [...new Set((normalizeSearch(value).match(/[a-z0-9]{3,}/g) || []))];

function markerContext(replyText, marker) {
  const text = String(replyText || '');
  const needle = `[${marker}]`;
  const position = text.indexOf(needle);
  if (position < 0) return '';
  const start = Math.max(text.lastIndexOf('\n', position - 320), text.lastIndexOf('.', position - 320), 0);
  const endCandidates = [text.indexOf('\n', position + needle.length), text.indexOf('.', position + needle.length)]
    .filter(index => index > position);
  const end = endCandidates.length ? Math.min(...endCandidates) + 1 : Math.min(text.length, position + 320);
  return text.slice(start, end);
}

function relevantExcerpt(fullText, query, claim = '', maxChars = MAX_EXCERPT_CHARS) {
  const text = String(fullText || '').trim();
  if (text.length <= maxChars) return normalizeExcerpt(text, maxChars);
  const tokens = searchTokens(`${query} ${claim}`);
  if (!tokens.length) return normalizeExcerpt(text, maxChars);
  const normalized = normalizeSearch(text);
  let bestPosition = 0;
  let bestScore = -1;
  const candidates = new Set([0]);
  for (const token of tokens) {
    let position = normalized.indexOf(token);
    while (position >= 0) {
      candidates.add(Math.max(0, position - Math.floor(maxChars / 2)));
      position = normalized.indexOf(token, position + token.length);
    }
  }
  for (const start of candidates) {
    const window = normalized.slice(start, start + maxChars);
    const score = tokens.reduce((sum, token) => sum + (window.includes(token) ? Math.min(6, token.length / 2) : 0), 0);
    if (score > bestScore) { bestScore = score; bestPosition = start; }
  }
  const start = Math.max(0, bestPosition - 60);
  const excerpt = text.slice(start, start + maxChars);
  return `${start > 0 ? '… ' : ''}${normalizeExcerpt(excerpt, maxChars - (start > 0 ? 2 : 0))}`;
}

// Models sometimes group sources as "[1, 3, 4]"; the checks and the UI expect one marker per source.
function splitGroupedMarkers(replyText) {
  return String(replyText || '').replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\](?!\s*\()/g,
    (_, list) => list.split(/\s*[,;]\s*/).map(marker => `[${marker}]`).join(''));
}

function findMarkers(replyText) {
  const markers = [];
  const pattern = /\[(\d+)\](?!\s*\()/g;
  let match;
  const text = splitGroupedMarkers(replyText);
  while ((match = pattern.exec(text)) !== null) {
    markers.push(Number(match[1]));
  }
  return markers;
}

function buildVerifiedCitations(replyText, evidence = [], question = '') {
  const byIndex = new Map(evidence.map(item => [Number(item.citationIndex), item]));
  const markers = findMarkers(replyText);
  const invalidMarkers = [...new Set(markers.filter(marker => !byIndex.has(marker)))];
  const validMarkers = [...new Set(markers.filter(marker => byIndex.has(marker)))];
  const citations = validMarkers.map(marker => {
    const hit = byIndex.get(marker);
    const payload = hit?.payload || {};
    return {
      marker,
      ...locator(payload),
      documentId: String(payload.documentId || ''),
      title: String(payload.title || 'Tài liệu không tên'),
      chunkIndex: Number(payload.chunkIndex || 0),
      excerpt: relevantExcerpt(payload.fullText, question, markerContext(replyText, marker)),
      sourceUrl: payload.documentId ? `/api/library/${encodeURIComponent(payload.documentId)}/file${payload.page ? `#page=${payload.page}` : ''}` : null
    };
  });
  const supportingEvidence = markers.length === 0 ? evidence.map(hit => {
    const payload = hit?.payload || {};
    return {
      marker: Number(hit.citationIndex) || 0,
      ...locator(payload),
      documentId: String(payload.documentId || ''),
      title: String(payload.title || 'Tài liệu không tên'),
      chunkIndex: Number(payload.chunkIndex || 0),
      excerpt: relevantExcerpt(payload.fullText, question, replyText),
      sourceUrl: payload.documentId ? `/api/library/${encodeURIComponent(payload.documentId)}/file${payload.page ? `#page=${payload.page}` : ''}` : null
    };
  }) : [];
  return {
    citations,
    supportingEvidence,
    validation: {
      usedDocumentContext: evidence.length > 0,
      validCitationCount: citations.length,
      invalidCitationIndexes: invalidMarkers,
      missingCitation: evidence.length > 0 && markers.length === 0,
      // Recorded, not enforced yet: numbers, dates, codes and links of a cited
      // sentence that its cited passages do not contain.
      ...(validMarkers.length ? { unsupportedClaims: require('../rag/verify').verifyClaims(replyText, evidence, question).unsupported } : {})
    }
  };
}

function removeInvalidMarkers(replyText, invalidMarkers = []) {
  if (!invalidMarkers.length) return String(replyText || '');
  const invalid = new Set(invalidMarkers.map(Number));
  return String(replyText || '').replace(/\[(\d+)\](?!\s*\()/g, (marker, index) => invalid.has(Number(index)) ? '' : marker);
}

module.exports = { buildVerifiedCitations, findMarkers, splitGroupedMarkers, markerContext, normalizeExcerpt, relevantExcerpt, removeInvalidMarkers };
