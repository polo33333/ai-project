'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/backend/services/embedding_policy');
const qdrant = require('../src/backend/services/qdrant_service');
const library = require('../src/backend/knowledge_core/services/library_service');
const retrieval = require('../src/backend/knowledge_core/services/retrieval_service');
const dictionary = require('../src/backend/services/dictionary_service');
const { buildSchemaContext } = require('../src/backend/intelligent_core/schema_context_service');
const { withIdentity } = require('../src/backend/services/schema_identity');

function mode(t, value) {
  const before = process.env.EMBEDDING_ENABLED;
  process.env.EMBEDDING_ENABLED = value;
  t.after(() => { if (before === undefined) delete process.env.EMBEDDING_ENABLED; else process.env.EMBEDDING_ENABLED = before; });
}

test('disabled mode blocks all vector network paths and startup dependencies', async t => {
  mode(t, 'false');
  const request = t.mock.method(qdrant, 'request', async () => { throw Error('Network forbidden'); });
  assert.equal(policy.enabled(), false);
  await assert.rejects(qdrant.embedTexts(['test']), { code: 'EMBEDDING_DISABLED' });
  assert.equal((await qdrant.syncTablesToQdrant([])).mode, 'lexical');
  assert.equal((await qdrant.indexDocumentChunks({ id: 'doc' }, ['text'])).mode, 'lexical');
  assert.equal((await qdrant.searchSchema('employee', 3, { detailed: true })).reason, 'embedding_disabled');
  assert.deepEqual(await qdrant.searchDocuments('text', 3, { documentIds: ['doc'] }), []);
  assert.equal(await qdrant.deleteDocumentChunks('doc'), true);
  assert.equal((await qdrant.getStatus()).disabled, true);
  const network = t.mock.method(global, 'fetch', async () => { throw Error('Startup network forbidden'); });
  const startup = require('../scripts/start');
  await startup.ensureQdrant();
  await startup.ensureOllama();
  assert.equal(network.mock.callCount(), 0);
  assert.equal(request.mock.callCount(), 0);
});

test('disabled schema retrieval still finds source-scoped Vietnamese schema by description', async t => {
  mode(t, 'false');
  const table = source => withIdentity({ dbSourceId: source, dbName: 'ERP', schemaName: 'dbo', tableName: 'M_Employee',
    tableDescription: 'Hồ sơ nhân viên', isActive: true, columns: [{ columnName: 'EmployeeCode', dataType: 'NVARCHAR', isVisible: true, description: 'Mã nhân viên' }] });
  t.mock.method(dictionary, 'getGroupedTables', () => [table('allowed'), table('other')]);
  t.mock.method(dictionary, 'getGlossary', () => []);
  const vector = t.mock.method(qdrant, 'searchSchema', async () => { throw Error('Vector forbidden'); });
  const result = await buildSchemaContext('Tra cứu hồ sơ nhân viên', { dbSourceId: 'allowed', forceRetrieval: true });
  assert.equal(result.mode, 'data');
  assert.ok(result.selectedTables.includes('M_Employee'));
  assert.equal(result.retrieval.semanticSearch.reason, 'embedding_disabled');
  assert.equal(vector.mock.callCount(), 0);
});

test('upload, lexical search and reindex work without embedding or Qdrant', async t => {
  mode(t, 'false');
  const request = t.mock.method(qdrant, 'request', async () => { throw Error('Network forbidden'); });
  const vector = t.mock.method(qdrant, 'searchDocuments', async () => { throw Error('Vector forbidden'); });
  const document = await library.addDocument({ title: 'Huong dan embedding-mode.csv', fileType: 'CSV',
    contentBase64: Buffer.from('Chức năng,Hướng dẫn\nTải app,Mở trang cài đặt để tải ứng dụng').toString('base64') });
  t.after(() => library.deleteDocument(document.id));
  assert.equal(document.indexMode, 'lexical');
  assert.equal(document.error, null);
  assert.ok(library.getChunks(document.id).length > 0);
  const result = await retrieval.search('tải ứng dụng', { documentIds: [document.id], scopeMode: 'selected' });
  assert.match(result.mode, /^lexical/);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every(hit => hit.payload.documentId === document.id));
  assert.match(result.results[0].payload.fullText, /tải ứng dụng/);
  const reindex = await library.reindexAll();
  assert.ok(reindex.indexed >= 1);
  assert.equal(reindex.failed.length, 0);
  assert.equal(request.mock.callCount(), 0);
  assert.equal(vector.mock.callCount(), 0);
});

test('legacy workflow retrieval uses lexical candidates when embedding is disabled', async t => {
  mode(t, 'false');
  const { WorkflowRetrieval, configuration } = require('../src/backend/automation/workflow_retrieval');
  assert.equal(configuration().method, 'lexical');
  const service = new WorkflowRetrieval({ fetchImpl: async () => { throw Error('Vector network forbidden'); } });
  const result = await service.search('employee address', [{ id: 'hr/employee', name: 'employee address', description: 'Find employee address', inputs: {} }], null, { routingMode: 'chat_model' });
  assert.equal(result.definitions[0].id, 'hr/employee');
  assert.equal(result.trace.method, 'bm25');
  assert.equal((await service.sync([], configuration())).mode, 'lexical');
});

test('enabled mode restores vector searches rather than leaving lexical-only mode latched', async t => {
  mode(t, 'true');
  assert.equal(policy.enabled(), true);
  t.mock.method(qdrant, 'ensureCollection', async () => {});
  const embed = t.mock.method(qdrant, 'embedTexts', async () => [[0.1, 0.2]]);
  t.mock.method(qdrant, 'request', async () => ({ result: [{ score: 0.9, payload: { tableName: 'M_Employee' } }] }));
  const result = await qdrant.searchSchema('employee', 3, { detailed: true });
  assert.equal(result.status, 'ok');
  assert.equal(result.results.length, 1);
  assert.equal(embed.mock.callCount(), 1);
});

test('schema and document retrieval never create collections or payload indexes', async t => {
  mode(t, 'true');
  const calls = [];
  t.mock.method(qdrant, 'embedTexts', async () => [[0.1, 0.2]]);
  t.mock.method(qdrant, 'request', async (path, method = 'GET') => {
    calls.push({ path, method });
    assert.ok(method === 'GET' || (method === 'POST' && path.endsWith('/points/search')));
    return { result: [] };
  });
  await qdrant.searchSchema('schema', 3);
  await qdrant.searchDocuments('document', 3, { documentIds: ['allowed-document'] });
  assert.equal(calls.length, 4);
  assert.ok(!calls.some(call => call.path.includes('/index')));
});
