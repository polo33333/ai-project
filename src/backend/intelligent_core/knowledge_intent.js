const STOP_WORDS = new Set([
  'cua', 'cho', 'voi', 'theo', 'trong', 'tren', 'duoi', 'nay', 'kia', 'mot',
  'cac', 'nhung', 'nhu', 'the', 'nao', 'khong', 'duoc', 'file', 'document',
  'master', 'plan', 'app', 'version'
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase().trim();
}

function meaningfulTokens(value) {
  return [...new Set(normalize(value).split(/\s+/)
    .filter(token => token.length >= 4 && !STOP_WORDS.has(token)))];
}

function matchesDocumentTitle(question, documents = []) {
  const queryTokens = new Set(meaningfulTokens(question));
  if (queryTokens.size === 0) return false;

  return documents.some(document => {
    const titleTokens = meaningfulTokens(document?.title || document?.name || '');
    return titleTokens.some(token => queryTokens.has(token));
  });
}

function needsKnowledgeSearch(question, { sourceIds = [], documents = [] } = {}) {
  if (Array.isArray(sourceIds) && sourceIds.length > 0) {
    return { needed: true, reason: 'selected_sources' };
  }

  const normalized = normalize(question);
  if (!normalized) return { needed: false, reason: 'empty_query' };

  const explicitKnowledgeIntent = /\b(tai lieu|tri thuc|thu vien|knowledge ?hub|quy trinh|quy dinh|chinh sach|huong dan|huong dan su dung|nghiep vu|kich ban|ke hoach|tra cuu|tim kiem|noi dung file|trong file|theo file|theo tai lieu)\b/.test(normalized);
  if (explicitKnowledgeIntent) {
    return { needed: true, reason: 'explicit_knowledge_intent' };
  }

  if (matchesDocumentTitle(question, documents)) {
    return { needed: true, reason: 'document_title_match' };
  }

  return { needed: false, reason: 'no_knowledge_intent' };
}

module.exports = { needsKnowledgeSearch, matchesDocumentTitle };
