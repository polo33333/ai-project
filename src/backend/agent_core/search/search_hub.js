/**
 * SearchHub — Bộ điều phối và hợp nhất tìm kiếm đa nguồn cho Agent
 * Kết nối:
 * 1. Database Schema & Data Dictionary (SQL Context)
 * 2. Vector Search & Knowledge Graph (Document RAG)
 */

const retrievalService = require('../../knowledge_core/services/retrieval_service');
const schemaContextService = require('../../intelligent_core/schema_context_service');
const dictionaryService = require('../../services/dictionary_service');

class SearchHub {
  /**
   * Tìm kiếm toàn diện theo ngữ cảnh câu hỏi người dùng
   * @param {string} query 
   * @param {object} options 
   */
  async searchAll(query, options = {}) {
    const { includeKnowledge = true, includeSchema = true, documentIds = [] } = options;

    const tasks = [];
    if (includeKnowledge) {
      tasks.push(
        retrievalService.search(query, { limit: 5, documentIds })
          .then(res => ({ type: 'knowledge', data: res }))
          .catch(err => ({ type: 'knowledge', error: err.message, data: { results: [] } }))
      );
    }

    if (includeSchema) {
      tasks.push(
        schemaContextService.buildSchemaContext(query)
          .then(res => ({ type: 'schema', data: res }))
          .catch(err => ({ type: 'schema', error: err.message, data: null }))
      );
    }

    const results = await Promise.all(tasks);
    const output = {
      query,
      knowledge: null,
      schema: null
    };

    for (const r of results) {
      if (r.type === 'knowledge') output.knowledge = r.data;
      if (r.type === 'schema') output.schema = r.data;
    }

    return output;
  }

  /**
   * Tra cứu thuật ngữ nghiệp vụ trong Từ điển dữ liệu
   */
  async searchGlossary(term) {
    try {
      const match = dictionaryService.findTerm?.(term);
      return { success: true, term, match };
    } catch (e) {
      return { success: false, term, error: e.message };
    }
  }
}

module.exports = new SearchHub();
