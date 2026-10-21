'use strict';
const crypto = require('node:crypto');
const cache = new Map();
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) throw new Error('MEMORY_VECTOR_INVALID');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('MEMORY_VECTOR_INVALID');
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
async function recall(memory, args, dependencies = {}) {
  const lexical = memory.list({ ...args, events: true, register: true, approvedOnly: true });
  if (!String(args.query || '').trim() || !(dependencies.enabled || require('../services/embedding_policy').enabled)())
    return { ...lexical, retrievalMode: 'lexical' };
  const service = dependencies.service || require('../services/qdrant_service');
  try {
    // Bound indexing work. Every candidate comes from the authorized PostgreSQL view.
    const recent = memory.list({ events: true, limit: 24, register: true, approvedOnly: true }).items;
    const candidates = [...new Map([...lexical.items, ...recent].map(item => [item.id, item])).values()].slice(0, 34);
    if (!candidates.length) return { ...lexical, retrievalMode: 'lexical' };
    const fingerprint = JSON.stringify([service.embeddingProvider, service.embeddingBaseUrl, service.embeddingModel, service.documentVectorSize]);
    const keyed = candidates.map(item => {
      const text = `${item.question}\n${item.workflowName || ''}\n${item.table || ''}`;
      return { item, text, key: crypto.createHash('sha256').update(JSON.stringify([item.owner, item.id, item.revision, fingerprint, text])).digest('hex') };
    });
    const missing = keyed.filter(item => !cache.has(item.key));
    // embedTexts refreshes governance for the actual embedding destination, including source egress policy.
    const vectors = await service.embedTexts([args.query, ...missing.map(item => item.text)]);
    if (vectors.length !== missing.length + 1) throw new Error('MEMORY_VECTOR_INCOMPLETE');
    missing.forEach((item, index) => { cosine(vectors[0], vectors[index + 1]); cache.set(item.key, vectors[index + 1]); });
    while (cache.size > 512) cache.delete(cache.keys().next().value);
    await (dependencies.refresh || require('../governance/context').refresh)();
    const actor = memory.actor();
    const current = new Map(memory.list({ events: true, limit: 100, approvedOnly: true }).items.map(item => [item.id, item]));
    const ranked = keyed.filter(({ item }) => current.get(item.id)?.revision === item.revision
      && memory.visible(item, actor) && memory.resourcesAllowed(item, true))
      .map(({ item, key }) => ({ item, score: cosine(vectors[0], cache.get(key)) }))
      .filter(entry => entry.score >= 0.25).sort((a, b) => b.score - a.score);
    const offset = Math.max(0, Number(args.offset) || 0), limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    return { items: ranked.slice(offset, offset + limit).map(entry => entry.item), total: ranked.length,
      hasMore: offset + limit < ranked.length, retrievalMode: 'semantic', candidateWindow: candidates.length,
      candidateIds: keyed.filter(({ item }) => current.get(item.id)?.revision === item.revision
        && memory.visible(item, actor) && memory.resourcesAllowed(item, true)).map(({ item }) => item.id) };
  } catch (error) {
    // Recheck ACL after any await, including outages. Never return an earlier permission snapshot.
    const result = memory.list({ ...args, events: true, register: true, approvedOnly: true });
    return { ...result, retrievalMode: 'lexical', fallback: error.code || 'EMBEDDING_UNAVAILABLE' };
  }
}
module.exports = { recall, cosine };
