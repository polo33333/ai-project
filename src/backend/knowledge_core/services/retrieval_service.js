const http = require('http');
const https = require('https');
const libraryService = require('./library_service');
const qdrantService = require('../../services/qdrant_service');
const { estimateTokens } = require('../../agent_core/harness/context_budget');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokenize = value => normalize(value).match(/[a-z0-9_]{2,}/g) || [];

function postJson(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error?.message || parsed.error || `Reranker HTTP ${res.statusCode}`));
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Reranker request timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

class RetrievalService {
  resolveScope(documentIds = [], scopeMode = null) {
    const mode = scopeMode || (documentIds.length ? 'selected' : 'all_authorized');
    if (!['all_authorized', 'selected', 'none'].includes(mode)) throw new Error(`Invalid knowledge scope mode: ${mode}`);
    if (mode === 'none') return { mode, documentIds: [] };
    const available = new Set(libraryService.getDocuments().map(document => String(document.id)));
    const requested = [...new Set(documentIds.map(String))];
    const effective = mode === 'selected' ? requested.filter(id => available.has(id)) : [...available];
    return { mode, documentIds: effective };
  }

  buildCorpus(documentIds = []) {
    const selected = new Set(documentIds.map(String));
    if (!selected.size) return [];
    return libraryService.getDocuments().filter(document => selected.has(String(document.id))).flatMap(document => {
      try {
        const { content } = libraryService.getContent(document.id);
        return libraryService.chunkText(content).map((text, chunkIndex) => ({
          id: `${document.id}:${chunkIndex}`,
          text,
          payload: { documentId: document.id, title: document.title, chunkIndex, fullText: text }
        }));
      } catch (_) { return []; }
    });
  }

  bm25(query, corpus, limit = 30) {
    const queryTokens = tokenize(query);
    if (!queryTokens.length || !corpus.length) return [];
    const documents = corpus.map(item => ({ ...item, tokens: tokenize(item.text) }));
    const averageLength = documents.reduce((sum, item) => sum + item.tokens.length, 0) / documents.length || 1;
    const documentFrequency = new Map();
    for (const document of documents) for (const token of new Set(document.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return documents.map(document => {
      const frequencies = new Map();
      for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const frequency = frequencies.get(token) || 0;
        if (!frequency) continue;
        const df = documentFrequency.get(token) || 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        score += idf * (frequency * 2.5) / (frequency + 1.5 * (0.25 + 0.75 * document.tokens.length / averageLength));
      }
      return { id: document.id, score, payload: document.payload, source: 'bm25' };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  graphRoute(query) {
    return (process.env.GRAPHRAG_ENABLED || 'true') === 'true' && /(quan he|lien quan|phu thuoc|anh huong|ket noi|giua|chuoi|tong hop|toan canh|vi sao|nguyen nhan)/.test(normalize(query));
  }

  graphSearch(query, corpus, limit = 20) {
    if (!this.graphRoute(query)) return [];
    const terms = new Set(tokenize(query).filter(token => token.length >= 4));
    const seeds = corpus.filter(item => tokenize(item.text).some(token => terms.has(token)));
    const entityPattern = /\b[A-ZĐ][\p{L}\p{N}_-]+(?:\s+[A-ZĐ][\p{L}\p{N}_-]+){0,4}\b/gu;
    const entities = new Set(seeds.flatMap(item => item.text.match(entityPattern) || []).map(normalize));
    return corpus.map(item => {
      const overlap = (item.text.match(entityPattern) || []).map(normalize).filter(entity => entities.has(entity)).length;
      return { id: item.id, score: overlap, payload: item.payload, source: 'graph' };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  fuse(resultSets, limit = 30) {
    const k = Number(process.env.RRF_K || 60);
    const fused = new Map();
    for (const results of resultSets) results.forEach((item, index) => {
      const id = item.id || `${item.payload?.documentId}:${item.payload?.chunkIndex}`;
      const current = fused.get(id) || { ...item, id, score: 0, retrievalSources: [] };
      current.score += 1 / (k + index + 1);
      if (item.source && !current.retrievalSources.includes(item.source)) current.retrievalSources.push(item.source);
      fused.set(id, current);
    });
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async rerank(query, candidates, limit) {
    const baseUrl = String(process.env.RERANKER_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl || (process.env.RERANKER_ENABLED || 'false') !== 'true') return candidates.slice(0, limit);
    try {
      const maxCandidates = Math.max(limit, Number(process.env.RERANKER_MAX_CANDIDATES || 20));
      const maxDocumentChars = Math.max(200, Number(process.env.RERANKER_MAX_DOCUMENT_CHARS || 1600));
      const maxTotalChars = Math.max(maxDocumentChars, Number(process.env.RERANKER_MAX_TOTAL_CHARS || 24000));
      const submitted = [];
      let totalChars = 0;
      for (const candidate of candidates.slice(0, maxCandidates)) {
        const text = String(candidate.payload?.fullText || '').slice(0, maxDocumentChars);
        if (!text || totalChars + text.length > maxTotalChars) continue;
        submitted.push({ candidate, text }); totalChars += text.length;
      }
      if (!submitted.length) return candidates.slice(0, limit);
      const response = await postJson(`${baseUrl}/rerank`, {
        model: process.env.RERANKER_MODEL || 'bge-reranker-v2-m3', query,
        documents: submitted.map(item => item.text), top_n: Math.min(limit, submitted.length)
      });
      const ranked = (response.results || response.data || []).map(result => ({
        ...submitted[Number(result.index)]?.candidate,
        score: Number(result.relevance_score ?? result.score ?? 0), reranked: true,
        rerankTruncated: submitted.length < candidates.length || totalChars >= maxTotalChars
      })).filter(item => item.payload && Number.isFinite(item.score));
      if (!ranked.length && candidates.length) throw new Error('Reranker returned no usable results');
      return ranked.slice(0, limit);
    } catch (error) {
      console.warn(`[Reranker] fallback to RRF: ${error.message}`);
      return candidates.slice(0, limit);
    }
  }

  packContext(candidates = [], tokenBudget = Number(process.env.AI_DOCUMENT_CONTEXT_TOKENS || 3000)) {
    const selected = [];
    let usedTokens = 0;
    for (const hit of candidates) {
      const payload = hit.payload || {};
      const marker = `[Tài liệu ${selected.length + 1}: ${payload.title || 'Không tên'} · đoạn ${Number(payload.chunkIndex || 0) + 1}]`;
      const content = `${marker}\n${payload.fullText || ''}`;
      const cost = estimateTokens(content) + 4;
      if (cost > tokenBudget - usedTokens) continue;
      selected.push({ ...hit, citationIndex: selected.length + 1, contextText: content });
      usedTokens += cost;
    }
    return { text: selected.map(item => item.contextText).join('\n\n'), selected, usedTokens,
      dropped: Math.max(0, candidates.length - selected.length), tokenBudget };
  }

  async search(query, { limit = 6, documentIds = [], scopeMode = null } = {}) {
    const scope = this.resolveScope(documentIds, scopeMode);
    if (!scope.documentIds.length) return { results: [], mode: 'empty_scope', graphActivated: false, scope };
    const candidateLimit = Math.max(limit, Number(process.env.RETRIEVAL_CANDIDATE_LIMIT || 30));
    const corpus = this.buildCorpus(scope.documentIds);
    const vectorResults = await qdrantService.searchDocuments(query, candidateLimit, { documentIds: scope.documentIds });
    const allowed = new Set(scope.documentIds);
    const dense = vectorResults.filter(item => allowed.has(String(item.payload?.documentId)))
      .map(item => ({ ...item, id: `${item.payload?.documentId}:${item.payload?.chunkIndex}`, source: 'dense' }));
    const graph = this.graphSearch(query, corpus, candidateLimit);
    const fused = this.fuse([dense, this.bm25(query, corpus, candidateLimit), graph], candidateLimit);
    return { results: await this.rerank(query, fused, limit), mode: graph.length ? 'hybrid_graph' : 'hybrid', graphActivated: graph.length > 0, scope };
  }
}

module.exports = new RetrievalService();
