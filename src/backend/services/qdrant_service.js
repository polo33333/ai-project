/**
 * Qdrant Vector DB Service
 * Connects to http://localhost:6333
 * Handles collection creation, payload indexing for Database Tables & Columns schema,
 * Business Glossary terminology, and vector search.
 */

const http = require('http');
const crypto = require('node:crypto');

function postJson(url, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? require('https') : http;
    const req = transport.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.error?.message || parsed.error || `Embedding HTTP ${res.statusCode}`));
        } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Embedding request timeout')));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

class QdrantService {
  constructor() {
    this.qdrantUrl = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
    this.collectionName = process.env.QDRANT_COLLECTION || 'database_schema_v2';
    this.vectorSize = parseInt(process.env.QDRANT_VECTOR_SIZE || '1024', 10);
    this.documentVectorSize = parseInt(process.env.QDRANT_DOCUMENT_VECTOR_SIZE || '1024', 10);
    this.embeddingModel = process.env.EMBEDDING_MODEL || 'bge-m3';
    this.embeddingProvider = (process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase();
    this.embeddingBaseUrl = (process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    // Ollama unloads a model after 5 idle minutes by default; reloading bge-m3 adds ~3 s to the next question.
    this.embeddingKeepAlive = process.env.EMBEDDING_KEEP_ALIVE || '30m';
    this.documentCollectionPromise = null;
  }

  /**
   * Helper HTTP Request for Qdrant API
   */
  async request(path, method = 'GET', body = null) {
    return require('./qdrant_http').requestJson(new URL(path,this.qdrantUrl),{
      method,body,timeoutMs:Number(process.env.QDRANT_REQUEST_TIMEOUT_MS||10000)
    });
  }

  generateDeterministicVector(text, size = this.documentVectorSize) {
    const vector = new Array(size).fill(0);
    const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
    for (const token of tokens) {
      let hash = 2166136261;
      for (const char of token) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
      vector[Math.abs(hash) % size] += hash % 2 ? 1 : -1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map(value => value / magnitude);
  }

  async embedTexts(texts, expectedSize = this.documentVectorSize) {
    require('./embedding_policy').assertEnabled();
    await require('../governance/context').refresh(`embedding:${this.embeddingModel}`, this.embeddingProvider === 'ollama' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(this.embeddingBaseUrl));
    const input = (Array.isArray(texts) ? texts : [texts]).map(value => String(value || ''));
    try {
      let response;
      if (this.embeddingProvider === 'openai') {
        response = await postJson(`${this.embeddingBaseUrl}/v1/embeddings`, { model: this.embeddingModel, input });
        const vectors = (response.data || []).sort((a, b) => a.index - b.index).map(item => item.embedding);
        if (vectors.length !== input.length) throw new Error('Embedding response is incomplete');
        if (vectors.some(vector => !Array.isArray(vector) || vector.length !== expectedSize)) throw new Error(`Embedding dimension does not match collection (${expectedSize})`);
        return vectors;
      }
      response = await postJson(`${this.embeddingBaseUrl}/api/embed`, { model: this.embeddingModel, input, keep_alive: this.embeddingKeepAlive });
      const vectors = response.embeddings || (response.embedding ? [response.embedding] : []);
      if (vectors.length !== input.length) throw new Error('Embedding response is incomplete');
      if (vectors.some(vector => !Array.isArray(vector) || vector.length !== expectedSize)) throw new Error(`Embedding dimension does not match collection (${expectedSize})`);
      return vectors;
    } catch (error) {
      if ((process.env.EMBEDDING_FALLBACK_MODE || 'error') !== 'deterministic') {
        const endpoint = new URL(this.embeddingBaseUrl).origin;
        throw Object.assign(new Error(`Embedding ${this.embeddingProvider}/${this.embeddingModel} at ${endpoint}: ${error.message}`),
          { code: 'EMBEDDING_UNAVAILABLE', cause: error });
      }
      console.warn(`[Embedding] ${this.embeddingModel} unavailable; deterministic fallback is active: ${error.message}`);
      return input.map(text => this.generateDeterministicVector(text, expectedSize));
    }
  }

  /** Loads the embedding model at startup so the first question does not wait for it. */
  async warmUp() {
    if (!require('./embedding_policy').enabled()) return false;
    try { await this.embedTexts(['warm-up']); return true; }
    catch (error) { console.warn(`[Embedding] Warm-up skipped: ${error.message}`); return false; }
  }

  /**
   * Ensure Qdrant collection exists
   */
  async ensureCollection(options = {}) {
    try {
      const collections = await this.request('/collections');
      const exists = collections.result?.collections?.some(c => c.name === this.collectionName);

      if (!exists) {
        await this.request(`/collections/${this.collectionName}`, 'PUT', {
          vectors: {
            size: this.vectorSize,
            distance: 'Cosine'
          }
        });
        const reason = options.reason === 'full_sync'
          ? 'recreated for full schema synchronization'
          : 'created because it did not exist';
        console.log(`[Qdrant] Collection '${this.collectionName}' ${reason}.`);
      }
      return true;
    } catch (err) {
      console.error(`[Qdrant] Error checking/creating collection:`, err.message);
      throw err;
    }
  }

  /**
   * Sync active tables, active columns, and business glossary to Qdrant collection.
   * NON-ACTIVE tables are 100% PURGED/REMOVED from Qdrant!
   * @param {Array} tablesStore Array of table objects from DictionaryService
   * @param {Array} glossaryStore Array of glossary objects from DictionaryService
   */
  syncTablesToQdrant(tablesStore, glossaryStore = [], relationshipsStore = [], domainAliases = {}) {
    const snapshot = structuredClone([tablesStore, glossaryStore, relationshipsStore, domainAliases]);
    const pending = (this.schemaSyncTail || Promise.resolve()).then(() => this.performSchemaSync(...snapshot));
    this.schemaSyncTail = pending.catch(() => {});
    return pending;
  }

  async performSchemaSync(tablesStore, glossaryStore = [], relationshipsStore = [], domainAliases = {}) {
    if (!require('./embedding_policy').enabled()) return { success: true, skipped: true, mode: 'lexical', totalPoints: 0 };
    try {
      // Prepare all embeddings before touching the existing searchable collection.
      const syncVersion = crypto.randomUUID();
      // 2. Filter ONLY active tables
      const activeTables = tablesStore.filter(t => t.isActive);
      const points = [];
      let pointId = 1;

      // 3. Index Active Tables & Columns
      for (const table of activeTables) {
        const visibleColumns = (table.columns || []).filter(column => column.isVisible !== false);
        // Table level metadata
        const aliases = Array.isArray(domainAliases?.[table.domain]) ? domainAliases[table.domain] : [];
        const aliasText = aliases.length ? ` Từ khóa nghiệp vụ: ${aliases.join(', ')}.` : '';
        const defaultsText = table.defaultMetric || table.defaultTimeColumn
          ? ` Mặc định: metric ${table.defaultMetric || 'không có'}, thời gian ${table.defaultTimeColumn || 'không có'}, tổng hợp ${table.defaultAggregation || 'SUM'}.` : '';
        const semanticText = table.semanticModel ? ` Nghiệp vụ: ${table.semanticModel.entity}. Một dòng: ${table.semanticModel.grain}. Từ đồng nghĩa: ${(table.semanticModel.aliases || []).join(', ')}. Nhóm: ${(table.semanticModel.segments || []).map(s=>s.label).join(', ')}.` : '';
        const tableText = `Bảng CSDL ${table.tableName} DB ${table.dbName || 'SQLServer_DB'}. Domain nghiệp vụ: ${table.domain || 'chưa khai báo'}.${aliasText}${defaultsText}${semanticText} ${table.tableDescription || ''}. Các cột: ${visibleColumns.map(c => c.columnName).join(', ')}`;
        const [tableVector] = await this.embedTexts([tableText], this.vectorSize);

        points.push({
          id: pointId++,
          vector: tableVector,
          payload: {
            type: 'table',
            tableId: table.tableId || null,
            dbSourceId: table.dbSourceId || null,
            tableName: table.tableName,
            dbName: table.dbName || 'SQLServer_DB',
            schemaName: table.schemaName || 'dbo',
            domain: table.domain || null,
            description: table.tableDescription || '',
            columnCount: visibleColumns.length,
            columnsList: visibleColumns.map(c => c.columnName),
            fullText: tableText
          }
        });

        // Column level metadata
        for (const col of visibleColumns) {
          const colText = `Bảng ${table.tableName} Cột ${col.columnName} (${col.dataType}), tên hiển thị: ${col.displayName || col.columnName}: ${col.description || ''} PrimaryKey: ${col.isPrimaryKey ? 'Yes' : 'No'}`;
          const [colVector] = await this.embedTexts([colText], this.vectorSize);

          points.push({
            id: pointId++,
            vector: colVector,
            payload: {
              type: 'column',
              tableId: table.tableId || null,
              columnId: col.columnId || null,
              dbSourceId: table.dbSourceId || null,
              tableName: table.tableName,
              dbName: table.dbName || 'SQLServer_DB',
              schemaName: table.schemaName || 'dbo',
              columnName: col.columnName,
              dataType: col.dataType,
              isPrimaryKey: !!col.isPrimaryKey,
              description: col.description || '',
              displayName: col.displayName || '',
              fullText: colText
            }
          });
        }
      }

      // 4. Index active table relationships so Text-to-SQL can infer JOIN paths.
      for (const relation of relationshipsStore || []) {
        const pairs = Array.isArray(relation.columnPairs) && relation.columnPairs.length
          ? relation.columnPairs
          : [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }];
        const pairText = pairs.map(pair => `${relation.sourceTable}.${pair.sourceColumn} → ${relation.targetTable}.${pair.targetColumn}`).join(', ');
        const relationText = `Quan hệ bảng: ${pairText} (${relation.cardinality || relation.relationType || 'liên kết'}). ${relation.businessRole || ''} ${relation.description || ''}`;
        points.push({
          id: pointId++,
          vector: (await this.embedTexts([relationText], this.vectorSize))[0],
          payload: {
            type: 'relationship',
            relationshipId: relation.id,
            sourceTableId: relation.sourceTableId || null,
            targetTableId: relation.targetTableId || null,
            sourceTable: relation.sourceTable,
            sourceColumn: relation.sourceColumn,
            targetTable: relation.targetTable,
            targetColumn: relation.targetColumn,
            columnPairs: pairs,
            status: relation.status || 'suggested',
            revision: relation.revision || 1,
            relationType: relation.relationType || 'many-to-one',
            description: relation.description || '',
            fullText: relationText
          }
        });
      }

      // 5. Index Business Glossary items
      if (glossaryStore && Array.isArray(glossaryStore)) {
        for (const item of glossaryStore) {
          const termText = `Thuật ngữ Business Glossary '${item.term}': ${item.fullMeaning} (Phân loại: ${item.category || 'Chung'})`;
          const [termVector] = await this.embedTexts([termText], this.vectorSize);

          points.push({
            id: pointId++,
            vector: termVector,
            payload: {
              type: 'glossary',
              term: item.term,
              fullMeaning: item.fullMeaning,
              category: item.category || 'Chung',
              fullText: termText
            }
          });
        }
      }

      await this.ensureCollection();
      let upsertRes;
      if (points.length) {
        for (const point of points) point.payload.schemaSyncVersion = syncVersion;
        upsertRes = await this.request(`/collections/${this.collectionName}/points?wait=true`, 'PUT', { points });
      }
      // Prune removed/inactive entries only after the new snapshot has been written.
      await this.request(`/collections/${this.collectionName}/points/delete?wait=true`, 'POST', {
        filter: { must_not: [{ key: 'schemaSyncVersion', match: { value: syncVersion } }] }
      });

      console.log(`[Qdrant] Full schema sync completed for '${this.collectionName}': ${points.length} points, ${activeTables.length} active tables, ${relationshipsStore?.length || 0} relationships, ${glossaryStore?.length || 0} glossary terms.`);

      return {
        success: true,
        indexedTables: activeTables.length,
        indexedGlossary: glossaryStore ? glossaryStore.length : 0,
        indexedRelationships: relationshipsStore ? relationshipsStore.length : 0,
        totalPoints: points.length,
        qdrantStatus: upsertRes?.status
      };
    } catch (err) {
      console.error(`[Qdrant] Sync error:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Search vector collection for relevant tables, columns & business glossary terms
   */
  async searchSchema(queryText, limit = 5, options = {}) {
    const detail = await this.searchSchemaDetailed(queryText, limit);
    return options.detailed ? detail : detail.results;
  }

  async searchSchemaDetailed(queryText, limit = 5) {
    if (!require('./embedding_policy').enabled()) return { results: [], status: 'skipped', errorCode: null, reason: 'embedding_disabled' };
    try {
      // Retrieval must not provision or rebuild indexes as a side effect.
      await this.request(`/collections/${this.collectionName}`);
      const [queryVector] = await this.embedTexts([queryText], this.vectorSize);

      const searchRes = await this.request(`/collections/${this.collectionName}/points/search`, 'POST', {
        vector: queryVector,
        limit: limit,
        with_payload: true
      });

      return { results: searchRes.result || [], status: 'ok', errorCode: null };
    } catch (err) {
      console.error(err.code === 'EMBEDDING_UNAVAILABLE' ? '[Embedding] Schema search unavailable:' : '[Qdrant] Search error:', err.message);
      return { results: [], status: 'degraded', errorCode: err.code === 'EMBEDDING_UNAVAILABLE' ? err.code : 'SCHEMA_SEARCH_FAILED' };
    }
  }

  async ensureDocumentCollection() {
    if (this.documentCollectionPromise) return this.documentCollectionPromise;
    this.documentCollectionPromise = (async () => {
      const collection = process.env.QDRANT_DOCUMENT_COLLECTION || 'knowledge_documents';
      const collections = await this.request('/collections');
      if (!collections.result?.collections?.some(item => item.name === collection)) {
        await this.request(`/collections/${collection}`, 'PUT', { vectors: { size: this.documentVectorSize, distance: 'Cosine' } });
      }
      for (const [fieldName, fieldSchema] of [['documentId', 'keyword'], ['type', 'keyword'], ['chunkIndex', 'integer']]) {
        try { await this.request(`/collections/${collection}/index?wait=true`, 'PUT', { field_name: fieldName, field_schema: fieldSchema }); }
        catch (error) { console.warn(`[Qdrant] Document payload index '${fieldName}' unavailable: ${error.message}`); }
      }
      return collection;
    })();
    try { return await this.documentCollectionPromise; }
    catch (error) { this.documentCollectionPromise = null; throw error; }
  }

  async indexDocumentChunks(document, chunks) {
    if (!require('./embedding_policy').enabled()) return { success: true, skipped: true, mode: 'lexical', totalPoints: 0 };
    // The new generation is written before the old one is removed, so a reindex
    // never leaves the document without vectors; a failed write removes its own points.
    const generation = require('crypto').randomUUID();
    let collection = null;
    try {
      collection = await this.ensureDocumentCollection();
      const vectors = [];
      for (let start = 0; start < chunks.length; start += 32) {
        vectors.push(...await this.embedTexts(chunks.slice(start, start + 32).map(chunk => `${document.title}\n${typeof chunk === 'string' ? chunk : chunk.text}`)));
      }
      const points = chunks.map((chunk, index) => ({
        id: require('crypto').randomUUID(),
        vector: vectors[index],
        payload: { ...(typeof chunk === 'string' ? {} : chunk), type: 'document_chunk', documentId: document.id, title: document.title, fileType: document.fileType, category: document.category, chunkIndex: index, fullText: typeof chunk === 'string' ? chunk : chunk.text, indexGeneration: generation }
      }));
      for (let start = 0; start < points.length; start += 100) {
        await this.request(`/collections/${collection}/points?wait=true`, 'PUT', { points: points.slice(start, start + 100) });
      }
      try {
        await this.request(`/collections/${collection}/points/delete?wait=true`, 'POST', { filter: {
          must: [{ key: 'documentId', match: { value: document.id } }], must_not: [{ key: 'indexGeneration', match: { value: generation } }] } });
      } catch (error) {
        // Stale points of an older revision are filtered out at search time; same-revision repeats are deduplicated.
        console.warn(`[Qdrant] Previous index of ${document.id} not removed: ${error.message}`);
        return { success: true, totalPoints: points.length, staleCleanup: false };
      }
      return { success: true, totalPoints: points.length };
    } catch (error) {
      if (collection) {
        await this.request(`/collections/${collection}/points/delete?wait=true`, 'POST', { filter: { must: [
          { key: 'documentId', match: { value: document.id } }, { key: 'indexGeneration', match: { value: generation } }] } }).catch(() => {});
      }
      return { success: false, error: error.message };
    }
  }

  async deleteDocumentChunks(documentId) {
    // Disabled mode has no Qdrant dependency. Old points stay inaccessible through
    // the current document scope/revision checks; rebuild vectors when re-enabled.
    if (!require('./embedding_policy').enabled()) return true;
    try {
      const collection = await this.ensureDocumentCollection();
      await this.request(`/collections/${collection}/points/delete?wait=true`, 'POST', { filter: { must: [{ key: 'documentId', match: { value: documentId } }] } });
      return true;
    } catch (_) {
      return false;
    }
  }

  // detailed: { results, status, errorCode } so callers can report a vector
  // outage instead of silently answering from keywords alone.
  async searchDocuments(queryText, limit = 6, { documentIds = [], detailed = false } = {}) {
    const reply = (results, status = 'ok', errorCode = null) => detailed ? { results, status, errorCode } : results;
    if (!require('./embedding_policy').enabled()) return reply([], 'disabled');
    try {
      const collection = process.env.QDRANT_DOCUMENT_COLLECTION || 'knowledge_documents';
      await this.request(`/collections/${collection}`);
      const [queryVector] = await this.embedTexts([queryText]);
      if (!documentIds.length) return reply([]);
      const result = await this.request(`/collections/${collection}/points/search`, 'POST', {
        vector: queryVector, limit, with_payload: true,
        filter: { must: [
          { key: 'type', match: { value: 'document_chunk' } },
          { key: 'documentId', match: { any: [...new Set(documentIds.map(String))] } }
        ] }
      });
      return reply(result.result || []);
    } catch (error) {
      console.warn(`[Qdrant] Document search degraded to keywords: ${error.message}`);
      return reply([], 'degraded', error.code === 'EMBEDDING_UNAVAILABLE' ? error.code : 'DOCUMENT_SEARCH_FAILED');
    }
  }

  /**
   * Get Qdrant collection status / stats
   */
  async getStatus() {
    if (!require('./embedding_policy').enabled()) return { connected: false, disabled: true, embeddingEnabled: false, mode: 'lexical', collectionName: this.collectionName, url: this.qdrantUrl };
    try {
      const res = await this.request(`/collections/${this.collectionName}`);
      return {
        connected: true,
        url: this.qdrantUrl,
        collectionName: this.collectionName,
        pointsCount: res.result?.points_count || 0,
        status: res.result?.status || 'green'
      };
    } catch (err) {
      return {
        connected: false,
        url: this.qdrantUrl,
        error: err.message
      };
    }
  }
}

module.exports = new QdrantService();
