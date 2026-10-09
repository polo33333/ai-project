'use strict';

const { hash: digest } = require('./contract');
const { normalize } = require('./registry');
const tev1 = require('./tev1_decision');
const { estimateTokens } = require('../agent_core/harness/context_budget');
const fail = (code, message) => Object.assign(new Error(message), { code });
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

function configuration() {
  const mode = process.env.CHAT_ROUTING_RETRIEVAL_MODE || 'off';
  if (!['off', 'shadow', 'on'].includes(mode)) throw fail('ROUTING_CONFIG_INVALID', 'Invalid workflow retrieval mode');
  const method = process.env.CHAT_ROUTING_RETRIEVAL_METHOD || 'hybrid';
  if (!['lexical', 'hybrid'].includes(method)) throw fail('ROUTING_CONFIG_INVALID', 'Invalid workflow retrieval method');
  return { mode, method, collection: process.env.CHAT_ROUTING_RETRIEVAL_COLLECTION || 'workflow_routing_v1',
    qdrantUrl: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    embeddingUrl: process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:11434',
    model: process.env.EMBEDDING_MODEL || 'bge-m3', provider: process.env.EMBEDDING_PROVIDER || 'ollama',
    size: positive(process.env.QDRANT_DOCUMENT_VECTOR_SIZE, 1024),
    topK: Math.min(20, positive(process.env.CHAT_ROUTING_RETRIEVAL_TOP_K, 15)),
    timeoutMs: positive(process.env.CHAT_ROUTING_RETRIEVAL_TIMEOUT_MS, 15000),
    targetTokens: Math.min(1850, positive(process.env.CHAT_ROUTING_RETRIEVAL_TASK_TARGET_TOKENS, 1700)) };
}

function card(definition) {
  return { id: definition.id, name: definition.name, description: definition.routingDescription || definition.description || '',
    examples: definition.routingExamples || definition.examples || [], aliases: definition.aliases || [], domain: definition.domain || '',
    routingScope: definition.routingScope || '',
    slots: Object.entries(definition.inputs || {}).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, slot]) => ({ key, label: slot.label || slot.ask || key })) };
}
function identity(definition, config) {
  const hash = digest({ card: card(definition), version: definition.packageVersion, definitionHash: definition.definitionHash,
    model: config.model, modelDigest: config.modelDigest, provider: config.provider, size: config.size, format: 1 });
  return { hash, id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}` };
}

function lexical(question, definitions) {
  const query = new Set(normalize(question).split(' ').filter(Boolean));
  const documents = definitions.map(definition => {
    const item = card(definition);
    return normalize([item.name, item.description, item.domain, ...item.examples, ...item.aliases,
      ...item.slots.map(slot => slot.label)].join(' ')).split(' ').filter(Boolean);
  });
  const average = documents.reduce((sum, words) => sum + words.length, 0) / Math.max(1, documents.length);
  const frequencies = new Map([...query].map(word => [word, documents.filter(words => words.includes(word)).length]));
  return definitions.map((definition, index) => {
    const words = documents[index];
    let score = 0;
    for (const word of query) {
      const tf = words.filter(token => token === word).length;
      if (!tf) continue;
      const df = frequencies.get(word);
      score += Math.log(1 + (documents.length - df + 0.5) / (df + 0.5)) * tf * 2.2
        / (tf + 1.2 * (0.25 + 0.75 * words.length / Math.max(1, average)));
    }
    return { id: definition.id, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
function fuse(vector, words) {
  const scores = new Map();
  for (const list of [vector, words]) list.forEach((item, index) => scores.set(item.id, (scores.get(item.id) || 0) + 1 / (60 + index + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

class WorkflowRetrieval {
  constructor({ fetchImpl = (...args) => fetch(...args) } = {}) { this.fetch = fetchImpl; this.cache = new Map(); }
  async json(url, method, body, signal) {
    const response = await this.fetch(url, { method, signal, headers: { 'Content-Type': 'application/json',
      ...(process.env.QDRANT_API_KEY && url.startsWith(configuration().qdrantUrl.replace(/\/$/, '') + '/') ? { 'api-key': process.env.QDRANT_API_KEY } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw Object.assign(fail('ROUTING_RETRIEVAL_UNAVAILABLE', `Workflow retrieval HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  async embed(texts, config, signal) {
    if (config.provider !== 'ollama') throw fail('ROUTING_RETRIEVAL_UNAVAILABLE', 'Workflow routing currently requires Ollama embeddings');
    const response = await this.json(`${config.embeddingUrl.replace(/\/$/, '')}/api/embed`, 'POST', { model: config.model, input: texts }, signal);
    const vectors = response.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length || vectors.some(vector => !Array.isArray(vector)
      || vector.length !== config.size || vector.some(value => !Number.isFinite(value)) || !vector.some(value => value !== 0))) {
      throw fail('ROUTING_RETRIEVAL_INVALID_VECTOR', 'Invalid workflow embedding vectors');
    }
    return vectors; // Strict: never use deterministic fallback from the RAG service.
  }
  async sync(definitions, config, signal, { readOnly = false } = {}) {
    if (!definitions.length) return;
    if (!config.modelDigest) {
      const tags = await this.json(`${config.embeddingUrl.replace(/\/$/, '')}/api/tags`, 'GET', undefined, signal);
      const model = (tags.models || []).find(item => [config.model, `${config.model}:latest`].includes(item.name || item.model));
      if (!model?.digest) throw fail('ROUTING_RETRIEVAL_MODEL_MISMATCH', 'Embedding model digest unavailable');
      config.modelDigest = model.digest;
    }
    const base = `${config.qdrantUrl.replace(/\/$/, '')}/collections/${encodeURIComponent(config.collection)}`;
    const response = await this.fetch(base, { signal, headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {} });
    if (response.status === 404) {
      if (readOnly) throw fail('ROUTING_RETRIEVAL_INDEX_MISSING', 'Workflow index is missing; publish or rebuild before hybrid routing');
      try { await this.json(base, 'PUT', { vectors: { size: config.size, distance: 'Cosine' } }, signal); }
      catch (error) {
        if (error.status !== 409) throw error;
        const info = await this.json(base, 'GET', undefined, signal);
        if (info.result?.config?.params?.vectors?.size !== config.size || info.result?.config?.params?.vectors?.distance !== 'Cosine') {
          throw fail('ROUTING_RETRIEVAL_INDEX_MISMATCH', 'Concurrent workflow collection configuration mismatch');
        }
      }
    } else {
      if (!response.ok) throw fail('ROUTING_RETRIEVAL_UNAVAILABLE', `Workflow collection HTTP ${response.status}`);
      const info = await response.json();
      if (info.result?.config?.params?.vectors?.size !== config.size || info.result?.config?.params?.vectors?.distance !== 'Cosine') {
        throw fail('ROUTING_RETRIEVAL_INDEX_MISMATCH', 'Workflow collection vector configuration mismatch');
      }
    }
    for (let offset = 0; offset < definitions.length; offset += 32) {
      const batch = definitions.slice(offset, offset + 32);
      const existing = await this.json(`${base}/points`, 'POST', { ids: batch.map(item => identity(item, config).id), with_payload: true, with_vector: false }, signal);
      const known = new Map((existing.result || []).map(point => [point.id, point.payload?.hash]));
      const missing = batch.filter(item => known.get(identity(item, config).id) !== identity(item, config).hash);
      if (!missing.length) continue;
      if (readOnly) throw fail('ROUTING_RETRIEVAL_INDEX_STALE', 'Workflow index is incomplete; publish or rebuild before hybrid routing');
      const vectors = await this.embed(missing.map(item => JSON.stringify(card(item))), config, signal);
      await this.json(`${base}/points?wait=true`, 'PUT', { points: missing.map((item, index) => {
        const key = identity(item, config);
        return { id: key.id, vector: vectors[index], payload: { hash: key.hash, workflowId: item.id, model: config.model, format: 1 } };
      }) }, signal);
    }
  }
  async checkIndex(definitions, config, signal) {
    return this.sync(definitions, config, signal, { readOnly: true });
  }
  async search(question, definitions, current, options = {}) {
    const config = configuration();
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(config.timeoutMs,
      options.executionBudget?.remainingMs() ?? config.timeoutMs))), ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    if (!definitions.length) throw fail('ROUTING_RETRIEVAL_EMPTY', 'No authorized workflow candidates');
    const query = String(question).normalize('NFC').trim();
    const words = lexical(query, definitions);
    let vectors = [];
    if (config.method === 'hybrid') {
      await this.checkIndex(definitions, config, signal);
      const cacheKey = digest({ query, model: config.model, modelDigest: config.modelDigest, url: config.embeddingUrl, size: config.size });
      let vector = this.cache.get(cacheKey);
      if (!vector || vector.expires < Date.now()) {
        vector = { value: (await this.embed([query], config, signal))[0], expires: Date.now() + 300000 };
        if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(cacheKey, vector);
      }
      const keys = new Map(definitions.map(item => [identity(item, config).id, item]));
      const response = await this.json(`${config.qdrantUrl.replace(/\/$/, '')}/collections/${encodeURIComponent(config.collection)}/points/search`, 'POST', {
        vector: vector.value, limit: config.topK + 1, with_payload: true,
        filter: { must: [{ has_id: [...keys.keys()] }] }
      }, signal);
      vectors = (response.result || []).filter(point => Number.isFinite(point.score) && keys.has(point.id) && point.payload?.hash === identity(keys.get(point.id), config).hash)
        .map(point => ({ id: keys.get(point.id).id, score: point.score }));
      if (!vectors.length) throw fail('ROUTING_RETRIEVAL_EMPTY', 'No verified workflow candidates');
    }
    const ranked = config.method === 'hybrid' ? fuse(vectors, words) : words;
    if (!ranked.length) throw fail('ROUTING_RETRIEVAL_EMPTY', 'No lexical candidates; clarify or use the authorized catalog');
    const pending = definitions.find(item => item.id === current?.templateId);
    const scoreFor = (list, id) => list.find(item => item.id === id)?.score || 0;
    let selected, task, evaluations;
    for (let count = Math.min(config.topK, ranked.length); count >= 1; count--) {
      const boundary = ranked[count - 1], excluded = ranked[count];
      // RRF rank gaps are not confidence: compare source scores for ties.
      if (boundary && excluded && Math.abs(scoreFor(vectors, boundary.id) - scoreFor(vectors, excluded.id)) < 1e-6
        && Math.abs(scoreFor(words, boundary.id) - scoreFor(words, excluded.id)) < 1e-6) {
        throw fail('ROUTING_RETRIEVAL_COMPETING_CANDIDATES', 'Competing workflows exceed shortlist capacity');
      }
      selected = ranked.slice(0, count).map(item => definitions.find(definition => definition.id === item.id));
      if (pending && !selected.some(item => item.id === pending.id)) selected.unshift(pending);
      const groups = new Set(selected.map(item => item.routingGroup).filter(Boolean));
      const siblings = definitions.filter(item => groups.has(item.routingGroup) && !selected.some(candidate => candidate.id === item.id));
      selected.push(...siblings);
      // A group is atomic: never remove a sibling merely to satisfy topK.
      if (selected.length > config.topK + (pending ? 1 : 0)) throw fail('ROUTING_RETRIEVAL_COMPETING_CANDIDATES', 'Workflow group exceeds shortlist capacity');
      // chat_model has its own context guard and does not consume TEV1 evaluations.
      try { task = options.routingMode === 'chat_model' ? null : tev1.buildTask(question, selected, current, options.history).task; }
      catch (error) { if (error.code === 'ROUTING_CONTEXT_EXCEEDED' && count > 1) continue; throw error; }
      evaluations = task ? Object.keys(task.questions).length : 0;
      if (!task || (estimateTokens(task) <= config.targetTokens && (!options.executionBudget ||
        options.executionBudget.modelCalls + evaluations + (options.routingMode === 'auto' ? 2 : 0) <= options.executionBudget.maxModelCalls))) break;
      if (count === 1) throw fail('ROUTING_CONTEXT_EXCEEDED', 'Workflow shortlist exceeds task or evaluation budget');
    }
    return { definitions: selected, trace: { catalogCount: definitions.length, candidateCount: selected.length,
      candidateIds: selected.map(item => item.id), taskTokens: task ? estimateTokens(task) : null, evaluations,
      model: config.method === 'hybrid' ? config.model : null, modelDigest: config.modelDigest || null,
      indexStatus: config.method === 'hybrid' ? 'ready' : 'not_required',
      routingGroups: [...new Set(selected.map(item => item.routingGroup).filter(Boolean))],
      retrievedCount: ranked.length, catalogHash: digest(definitions.map(item => identity(item, config).id).sort()), method: config.method === 'hybrid' ? 'vector_bm25_rrf' : 'bm25' } };
  }
}
module.exports = { WorkflowRetrieval, configuration, card, identity, lexical, fuse, service: new WorkflowRetrieval() };
