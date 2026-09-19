const MAX_EXCERPT_CHARS = 520;

function normalizeExcerpt(value, maxChars = MAX_EXCERPT_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const shortened = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return `${shortened}…`;
}

const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
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

function findMarkers(replyText) {
  const markers = [];
  const pattern = /\[(\d+)\](?!\s*\()/g;
  let match;
  while ((match = pattern.exec(String(replyText || ''))) !== null) {
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
      documentId: String(payload.documentId || ''),
      title: String(payload.title || 'Tài liệu không tên'),
      chunkIndex: Number(payload.chunkIndex || 0),
      excerpt: relevantExcerpt(payload.fullText, question, markerContext(replyText, marker)),
      sourceUrl: payload.documentId ? `/api/library/${encodeURIComponent(payload.documentId)}/file` : null
    };
  });
  const supportingEvidence = markers.length === 0 ? evidence.map(hit => {
    const payload = hit?.payload || {};
    return {
      marker: Number(hit.citationIndex) || 0,
      documentId: String(payload.documentId || ''),
      title: String(payload.title || 'Tài liệu không tên'),
      chunkIndex: Number(payload.chunkIndex || 0),
      excerpt: relevantExcerpt(payload.fullText, question, replyText),
      sourceUrl: payload.documentId ? `/api/library/${encodeURIComponent(payload.documentId)}/file` : null
    };
  }) : [];
  return {
    citations,
    supportingEvidence,
    validation: {
      usedDocumentContext: evidence.length > 0,
      validCitationCount: citations.length,
      invalidCitationIndexes: invalidMarkers,
      missingCitation: evidence.length > 0 && markers.length === 0
    }
  };
}

function removeInvalidMarkers(replyText, invalidMarkers = []) {
  if (!invalidMarkers.length) return String(replyText || '');
  const invalid = new Set(invalidMarkers.map(Number));
  return String(replyText || '').replace(/\[(\d+)\](?!\s*\()/g, (marker, index) => invalid.has(Number(index)) ? '' : marker);
}

module.exports = { buildVerifiedCitations, findMarkers, markerContext, normalizeExcerpt, relevantExcerpt, removeInvalidMarkers };
