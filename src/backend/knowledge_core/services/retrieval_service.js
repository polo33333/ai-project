const http = require('http');
const https = require('https');
const libraryService = require('./library_service');
const qdrantService = require('../../services/qdrant_service');

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
  buildCorpus(documentIds = []) {
    const selected = new Set(documentIds.map(String));
    return libraryService.getDocuments().filter(document => !selected.size || selected.has(String(document.id))).flatMap(document => {
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
      const response = await postJson(`${baseUrl}/rerank`, {
        model: process.env.RERANKER_MODEL || 'bge-reranker-v2-m3', query,
        documents: candidates.map(item => item.payload?.fullText || ''), top_n: limit
      });
      const ranked = (response.results || response.data || []).map(result => ({
        ...candidates[Number(result.index)], score: Number(result.relevance_score ?? result.score ?? 0), reranked: true
      })).filter(item => item.payload);
      if (!ranked.length && candidates.length) throw new Error('Reranker returned no usable results');
      return ranked.slice(0, limit);
    } catch (error) {
      console.warn(`[Reranker] fallback to RRF: ${error.message}`);
      return candidates.slice(0, limit);
    }
  }

  async search(query, { limit = 6, documentIds = [] } = {}) {
    const candidateLimit = Math.max(limit, Number(process.env.RETRIEVAL_CANDIDATE_LIMIT || 30));
    const corpus = this.buildCorpus(documentIds);
    const vectorResults = await qdrantService.searchDocuments(query, candidateLimit);
    const allowed = new Set(documentIds.map(String));
    const dense = vectorResults.filter(item => !allowed.size || allowed.has(String(item.payload?.documentId)))
      .map(item => ({ ...item, id: `${item.payload?.documentId}:${item.payload?.chunkIndex}`, source: 'dense' }));
    const graph = this.graphSearch(query, corpus, candidateLimit);
    const fused = this.fuse([dense, this.bm25(query, corpus, candidateLimit), graph], candidateLimit);
    return { results: await this.rerank(query, fused, limit), mode: graph.length ? 'hybrid_graph' : 'hybrid', graphActivated: graph.length > 0 };
  }
}

module.exports = new RetrievalService();
