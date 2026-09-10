/**
 * Qdrant Vector DB Service
 * Connects to http://localhost:6333
 * Handles collection creation, payload indexing for Database Tables & Columns schema,
 * Business Glossary terminology, and vector search.
 */

const http = require('http');

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
  }

  /**
   * Helper HTTP Request for Qdrant API
   */
  async request(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.qdrantUrl);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.status?.error || `Qdrant HTTP Error ${res.statusCode}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', (err) => reject(err));

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Simple, fast deterministic embedding generator (384 dimensions)
   */
  generateVector(text) {
    const vector = new Array(this.vectorSize).fill(0);
    const str = String(text).toLowerCase();
    
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const index = (charCode * (i + 1) * 31) % this.vectorSize;
      vector[index] += Math.sin(charCode + i) * 0.1;
    }

    // Normalize vector
    const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0)) || 1;
    return vector.map(val => Number((val / magnitude).toFixed(6)));
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
      response = await postJson(`${this.embeddingBaseUrl}/api/embed`, { model: this.embeddingModel, input });
      const vectors = response.embeddings || (response.embedding ? [response.embedding] : []);
      if (vectors.length !== input.length) throw new Error('Embedding response is incomplete');
      if (vectors.some(vector => !Array.isArray(vector) || vector.length !== expectedSize)) throw new Error(`Embedding dimension does not match collection (${expectedSize})`);
      return vectors;
    } catch (error) {
      if ((process.env.EMBEDDING_FALLBACK_MODE || 'error') !== 'deterministic') throw error;
      console.warn(`[Embedding] ${this.embeddingModel} unavailable; deterministic fallback is active: ${error.message}`);
      return input.map(text => this.generateDeterministicVector(text, expectedSize));
    }
  }

  /**
   * Ensure Qdrant collection exists
   */
  async ensureCollection() {
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
        console.log(`[Qdrant] Collection '${this.collectionName}' created successfully.`);
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
  async syncTablesToQdrant(tablesStore, glossaryStore = [], relationshipsStore = [], domainAliases = {}) {
    try {
      // 1. Purge all existing collection points first to ensure inactive or deleted tables are completely removed!
      try {
        await this.request(`/collections/${this.collectionName}`, 'DELETE');
      } catch (e) {
        // ignore if collection didn't exist
      }
      await this.ensureCollection();

      // 2. Filter ONLY active tables
      const activeTables = tablesStore.filter(t => t.isActive);
      const points = [];
      let pointId = 1;

      // 3. Index Active Tables & Columns
      for (const table of activeTables) {
        // Table level metadata
        const aliases = Array.isArray(domainAliases?.[table.domain]) ? domainAliases[table.domain] : [];
        const aliasText = aliases.length ? ` Từ khóa nghiệp vụ: ${aliases.join(', ')}.` : '';
        const defaultsText = table.defaultMetric || table.defaultTimeColumn
          ? ` Mặc định: metric ${table.defaultMetric || 'không có'}, thời gian ${table.defaultTimeColumn || 'không có'}, tổng hợp ${table.defaultAggregation || 'SUM'}.` : '';
        const tableText = `Bảng CSDL ${table.tableName} DB ${table.dbName || 'SQLServer_DB'}. Domain nghiệp vụ: ${table.domain || 'chưa khai báo'}.${aliasText}${defaultsText} ${table.tableDescription || ''}. Các cột: ${table.columns.map(c => c.columnName).join(', ')}`;
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
            columnCount: table.columns.length,
            columnsList: table.columns.map(c => c.columnName),
            fullText: tableText
          }
        });

        // Column level metadata
        for (const col of table.columns) {
          const colText = `Bảng ${table.tableName} Cột ${col.columnName} (${col.dataType}): ${col.description || ''} PrimaryKey: ${col.isPrimaryKey ? 'Yes' : 'No'}`;
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
              fullText: colText
            }
          });
        }
      }

      // 4. Index active table relationships so Text-to-SQL can infer JOIN paths.
      for (const relation of relationshipsStore || []) {
        const relationText = `Quan hệ bảng: ${relation.sourceTable}.${relation.sourceColumn} ${relation.relationType || 'liên kết'} ${relation.targetTable}.${relation.targetColumn}. ${relation.description || ''}`;
        points.push({
          id: pointId++,
          vector: (await this.embedTexts([relationText], this.vectorSize))[0],
          payload: {
            type: 'relationship',
            sourceTable: relation.sourceTable,
            sourceColumn: relation.sourceColumn,
            targetTable: relation.targetTable,
            targetColumn: relation.targetColumn,
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

      if (points.length === 0) {
        console.log(`[Qdrant] Collection reset: 0 active tables / 0 glossary items.`);
        return {
          success: true,
          indexedTables: 0,
          indexedGlossary: 0,
          totalPoints: 0,
          message: 'Đã xóa toàn bộ vector trên Qdrant do không có bảng nào Active.'
        };
      }

      // Batch upsert to Qdrant
      const upsertRes = await this.request(`/collections/${this.collectionName}/points?wait=true`, 'PUT', {
        points: points
      });

      console.log(`[Qdrant] Successfully indexed ${points.length} points (${activeTables.length} active tables & ${glossaryStore ? glossaryStore.length : 0} glossary terms) into Qdrant collection '${this.collectionName}'.`);

      return {
        success: true,
        indexedTables: activeTables.length,
        indexedGlossary: glossaryStore ? glossaryStore.length : 0,
        indexedRelationships: relationshipsStore ? relationshipsStore.length : 0,
        totalPoints: points.length,
        qdrantStatus: upsertRes.status
      };
    } catch (err) {
      console.error(`[Qdrant] Sync error:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Search vector collection for relevant tables, columns & business glossary terms
   */
  async searchSchema(queryText, limit = 5) {
    try {
      await this.ensureCollection();
      const [queryVector] = await this.embedTexts([queryText], this.vectorSize);

      const searchRes = await this.request(`/collections/${this.collectionName}/points/search`, 'POST', {
        vector: queryVector,
        limit: limit,
        with_payload: true
      });

      return searchRes.result || [];
    } catch (err) {
      console.error(`[Qdrant] Search error:`, err.message);
      return [];
    }
  }

  async ensureDocumentCollection() {
    const collection = process.env.QDRANT_DOCUMENT_COLLECTION || 'knowledge_documents';
    const collections = await this.request('/collections');
    if (!collections.result?.collections?.some(item => item.name === collection)) {
      await this.request(`/collections/${collection}`, 'PUT', { vectors: { size: this.documentVectorSize, distance: 'Cosine' } });
    }
    return collection;
  }

  async indexDocumentChunks(document, chunks) {
    try {
      const collection = await this.ensureDocumentCollection();
      await this.deleteDocumentChunks(document.id);
      const vectors = [];
      for (let start = 0; start < chunks.length; start += 32) {
        vectors.push(...await this.embedTexts(chunks.slice(start, start + 32).map(text => `${document.title}\n${text}`)));
      }
      const points = chunks.map((text, index) => ({
        id: require('crypto').randomUUID(),
        vector: vectors[index],
        payload: { type: 'document_chunk', documentId: document.id, title: document.title, fileType: document.fileType, category: document.category, chunkIndex: index, fullText: text }
      }));
      for (let start = 0; start < points.length; start += 100) {
        await this.request(`/collections/${collection}/points?wait=true`, 'PUT', { points: points.slice(start, start + 100) });
      }
      return { success: true, totalPoints: points.length };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async deleteDocumentChunks(documentId) {
    try {
      const collection = await this.ensureDocumentCollection();
      await this.request(`/collections/${collection}/points/delete?wait=true`, 'POST', { filter: { must: [{ key: 'documentId', match: { value: documentId } }] } });
      return true;
    } catch (_) {
      return false;
    }
  }

  async searchDocuments(queryText, limit = 6) {
    try {
      const collection = await this.ensureDocumentCollection();
      const [queryVector] = await this.embedTexts([queryText]);
      const result = await this.request(`/collections/${collection}/points/search`, 'POST', {
        vector: queryVector, limit, with_payload: true
      });
      return result.result || [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Get Qdrant collection status / stats
   */
  async getStatus() {
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
