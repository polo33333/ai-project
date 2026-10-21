'use strict';
// Real persisted metadata + existing local vector services. No SQL business query,
// workflow execution, index provisioning, production writes, or cloud model calls.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  loadEnvironment();
  const pool = createPool({ runtime: true }); let documents, definitions = [];
  try {
    ({ documents } = await new PostgresRepository(pool).snapshot(['dictionary.json', 'glossary.json', 'table_relationships.json',
      'domain_aliases.json', 'library.json', 'episodic_memory.json', 'db_sources.json']));
    const catalog = await pool.query("SELECT id, document->'published' AS published, document->'deletedTemplates' AS deleted FROM app.workflow_catalog WHERE document->>'enabled'='true' AND document->'published' IS NOT NULL");
    definitions = catalog.rows.flatMap(record => (record.published.templates || []).filter(template => template.enabled !== false && !record.deleted?.[template.id]).map(template => ({
      id: `${record.id}/${template.id}`, name: template.name, description: template.description, inputs: template.inputs,
      routingDescription: template.routingDescription, routingExamples: template.routingExamples, examples: template.examples, aliases: template.aliases,
      routingScope: template.routingScope, domain: template.domain || record.published.manifest.domain || '',
      packageVersion: record.published.manifest.version, definitionHash: require('../src/backend/automation/contract').hash(template) })));
  } finally { await pool.end(); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgehub-source-eval-'));
  process.env.APP_STORAGE_BACKEND = 'json'; process.env.KNOWLEDGEHUB_DATA_DIR = directory;
  process.env.EMBEDDING_FALLBACK_MODE = 'error'; process.env.RERANKER_ENABLED = 'false';
  const write = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data));
  for (const name of ['dictionary.json', 'glossary.json', 'table_relationships.json', 'domain_aliases.json']) write(name, documents.get(name) || []);
  write('library.json', []);
  write('db_sources.json', (documents.get('db_sources.json') || []).map(source => ({ id: source.id, governedPolicy: source.governedPolicy })));
  const tables = documents.get('dictionary.json') || [], docs = documents.get('library.json') || [], events = documents.get('episodic_memory.json') || [];
  const library = require('../src/backend/knowledge_core/services/library_service'); library.documents = docs;
  const retrieval = require('../src/backend/knowledge_core/services/retrieval_service');
  const schema = require('../src/backend/intelligent_core/schema_context_service');
  const qdrant = require('../src/backend/services/qdrant_service');
  if (qdrant.embeddingProvider !== 'ollama' || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(qdrant.embeddingBaseUrl).hostname)) throw new Error('LOCAL_EMBEDDING_REQUIRED');
  const labels = [], contextByCase = new Map();
  const add = (block, entityId, query, expectedIds, sourceScope, context) => {
    const caseId = `${block}:${hash([entityId, query, sourceScope]).slice(0, 24)}`;
    const groupId = hash([block, entityId, sourceScope]);
    const existing = labels.find(label => label.caseId === caseId);
    if (existing) { existing.expectedIds = [...new Set([...existing.expectedIds, ...expectedIds])]; return; }
    labels.push({ caseId, block, groupId, languageGroup: null, split: parseInt(groupId.slice(0, 2), 16) % 5 === 0 ? 'holdout' : 'dev',
      query, sourceScope, expectedIds, expectedDisposition: 'retrieve', reviewer: null, approvedAt: null });
    contextByCase.set(caseId, context);
  };
  for (const table of tables.filter(table => table.isActive !== false)) {
    const id = require('../src/backend/services/schema_identity').tableIdentity(table);
    add('E1', id, `Tìm bảng ${table.tableName}`, [id], `sql:${table.dbSourceId}`, table);
    for (const column of (table.columns || []).filter(column => column.isVisible !== false))
      add('E1', id, `Tìm trường ${column.displayName || column.description || column.columnName} của bảng ${table.tableName}`, [id], `sql:${table.dbSourceId}`, table);
  }
  for (const document of docs) {
    try {
      for (const chunk of library.getChunks(document.id)) {
        if (!chunk.text?.trim()) continue;
        add('E2', document.id, chunk.text.trim().slice(0, 160), [`${document.id}:${chunk.chunkIndex}`], `document:${document.id}`, document);
      }
    } catch (_) { /* Unreadable/revision-invalid documents are not invented as labels. */ }
  }
  for (const event of events) if (event.question?.trim()) add('E4', event.sessionId || event.id, event.question,
    [event.id], `memory-owner:${hash(event.owner)}`, event);
  for (const definition of definitions) add('E3', definition.id, definition.name, [definition.id], `published-workflow-catalog:${hash(definitions)}`, definition);
  const observations = [], warnings = [];
  let counters = { embeddingCalls: 0, qdrantCalls: 0 };
  const originalRequest = qdrant.request.bind(qdrant), originalEmbed = qdrant.embedTexts.bind(qdrant);
  qdrant.request = async (url, method = 'GET', body) => {
    if (method !== 'GET' && !(method === 'POST' && url.endsWith('/points/search'))) throw Object.assign(new Error('Index writes forbidden during evaluation'), { code: 'EVAL_WRITE_BLOCKED' });
    counters.qdrantCalls++; return originalRequest(url, method, body);
  };
  qdrant.embedTexts = async (...args) => { counters.embeddingCalls++; return originalEmbed(...args); };
  const workflowService = new (require('../src/backend/automation/workflow_retrieval').WorkflowRetrieval)({ fetchImpl: async (value, options = {}) => {
    const url = new URL(value), method = options.method || 'GET';
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_SERVICE_REQUIRED');
    if (method !== 'GET' && !(method === 'POST' && (url.pathname.endsWith('/points/search') || url.pathname.endsWith('/points') || url.pathname === '/api/embed'))) throw new Error('EVAL_WRITE_BLOCKED');
    if (url.pathname.startsWith('/collections/')) counters.qdrantCalls++;
    if (url.pathname === '/api/embed') counters.embeddingCalls++;
    return fetch(value, options);
  } });
  for (const block of ['E1', 'E2', 'E3', 'E4']) {
    for (const label of labels.filter(label => label.block === block).slice(0, process.argv.includes('--all') ? undefined : 3)) {
      for (const mode of ['off', 'on']) {
        process.env.EMBEDDING_ENABLED = mode === 'on' ? 'true' : 'false';
        counters = { embeddingCalls: 0, qdrantCalls: 0 }; const started = Date.now();
        let candidateIds = [], rankedIds = [], errorCode = null;
        const context = contextByCase.get(label.caseId);
        try {
          if (block === 'E1') {
            const result = await schema.buildSchemaContext(label.query, { dbSourceId: context.dbSourceId, forceRetrieval: true });
            candidateIds = result.retrieval?.candidateIds || result.selectedTableIds || [];
            rankedIds = result.selectedTableIds || [];
            if (result.retrieval?.semanticSearch?.status === 'degraded') errorCode = result.retrieval.semanticSearch.errorCode || 'SCHEMA_VECTOR_DEGRADED';
          } else if (block === 'E2') {
            const result = await retrieval.search(label.query, { limit: 5, documentIds: [context.id], scopeMode: 'selected' });
            candidateIds = result.candidateIds || []; rankedIds = result.results.map(item => String(item.id));
          } else if (block === 'E3') {
            process.env.CHAT_ROUTING_RETRIEVAL_METHOD = mode === 'on' ? 'hybrid' : 'lexical';
            const result = await workflowService.search(label.query, definitions, null, { routingMode: 'chat_model' });
            candidateIds = result.trace.candidateIds; rankedIds = result.definitions.map(item => item.id);
          } else {
            const governance = require('../src/backend/governance/context');
            await governance.run(async () => {
              governance.setPrincipal({ subject: context.owner, role: 'user', tenantId: context.organization });
              const Memory = require('../src/backend/memory_core/durable_memory').DurableMemory;
              const memory = new Memory({ records: [], events, saveEvents() {}, saveRecords() {} });
              const result = await require('../src/backend/memory_core/semantic_recall').recall(memory, { query: label.query, limit: 5 });
              candidateIds = result.candidateIds || result.items.map(item => item.id); rankedIds = result.items.map(item => item.id);
              if (result.fallback) errorCode = result.fallback;
            });
          }
        } catch (error) { errorCode = error.code || 'RETRIEVAL_FAILED'; }
        observations.push({ caseId: label.caseId, runId: 'smoke-1', mode, candidateIds: [...new Set([...candidateIds, ...rankedIds])],
          rankedIds: [...new Set(rankedIds)], disposition: rankedIds.length ? 'retrieve' : 'no_match', latencyMs: Date.now() - started,
          ...counters, errorCode, tokens: null, safety: { permission: 'not_checked', injection: 'not_checked', noFabrication: 'not_checked' } });
      }
    }
  }
  const output = path.resolve('artifacts/agent-acceptance'); fs.mkdirSync(output, { recursive: true });
  const input = { schemaVersion: '1', snapshot: { sourceRevision: hash(labels), modelRevision: qdrant.embeddingModel,
    configRevision: hash([qdrant.collectionName, qdrant.documentVectorSize]), principalRef: 'local_snapshot_smoke_not_authenticated_channel_acceptance' },
    policy: { minLabelsPerBlock: 50, k: 5, margin: 0.02, alpha: 0.05 }, labels, observations };
  fs.writeFileSync(path.join(output, 'source-retrieval.private.json'), JSON.stringify(input, null, 2));
  const preview = ['E1', 'E2', 'E3', 'E4'].map(block => {
    const chosen = observations.filter(row => contextByCase.has(row.caseId) && labels.find(label => label.caseId === row.caseId).block === block);
    return { block, draftLabels: labels.filter(label => label.block === block).length, observations: chosen.length,
      hits: chosen.filter(row => labels.find(label => label.caseId === row.caseId).expectedIds.some(id => row.rankedIds.includes(id))).length,
      errors: chosen.filter(row => row.errorCode).map(row => row.errorCode) };
  });
  warnings.push('Draft labels and exact-source-text smoke queries are not approved business acceptance.',
    'Historical E3 drafts remain separate from the current published-catalog smoke.', '22 stored events cannot establish outside-34-window acceptance.');
  fs.writeFileSync(path.join(output, 'source-retrieval-smoke.json'), JSON.stringify({ preview, warnings }, null, 2));
  console.log(JSON.stringify({ preview, warnings }, null, 2));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
