'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rag = require('../src/backend/knowledge_core/rag');
const { understand, stripCommand } = require('../src/backend/knowledge_core/rag/query');
const { verifyClaims } = require('../src/backend/knowledge_core/rag/verify');
const retrieval = require('../src/backend/knowledge_core/services/retrieval_service');
const library = require('../src/backend/knowledge_core/services/library_service');
const qdrant = require('../src/backend/services/qdrant_service');
const structured = require('../src/backend/knowledge_core/services/structured_document');
const scoring = require('../scripts/eval/document_retrieval_scoring');
const { computeMetrics } = require('../src/backend/training_core/pipeline_metrics');

const documents = [{ id: 'guide', title: 'TPSOFT_HDSD_IPMS_APP__v1.0.docx' }, { id: 'plan', title: 'Phase1_SQLServer_Connector_Plan.docx' }];

test('words addressed to the library are removed from the search query', () => {
  assert.equal(stripCommand('kho tri thức: cách đổi mật khẩu app IPMS'), 'cách đổi mật khẩu app IPMS');
  assert.equal(stripCommand('tìm trong kho tri thức hướng dẫn cài đặt IPMS'), 'hướng dẫn cài đặt IPMS');
  assert.equal(stripCommand('Dựa trên kho tài liệu, SQL Server dùng cổng nào?'), 'SQL Server dùng cổng nào?');
  assert.equal(stripCommand('tài liệu trên có mấy trang'), 'tài liệu trên có mấy trang');
  assert.equal(stripCommand('kho tri thức'), 'kho tri thức');
});

test('a file name scopes retrieval to that document and the rest of the question ranks its passages', () => {
  const named = understand({ question: 'Trong TPSOFT_HDSD_IPMS_APP__v1.0.docx cách đổi mật khẩu?', documents });
  assert.deepEqual(named.documentIds, ['guide']);
  assert.equal(named.method, 'file_name');
  assert.equal(named.searchQuery, 'Trong cách đổi mật khẩu?');
  const only = understand({ question: 'Phase1_SQLServer_Connector_Plan.docx', documents });
  assert.deepEqual(only.documentIds, ['plan']);
  assert.equal(only.searchQuery, 'Phase1 SQLServer Connector Plan');
});

test('a follow-up stays inside the documents of the previous cited answer', () => {
  const previous = { question: 'App IPMS có chức năng nào', documentIds: ['guide'] };
  for (const question of ['còn chức năng rác?', 'phần đường ống thì sao', 'tài liệu trên nói gì về phản ánh']) {
    const result = understand({ question, previous, documents });
    assert.deepEqual(result.documentIds, ['guide'], question);
    assert.equal(result.method, 'followup_scope');
  }
  assert.equal(understand({ question: 'SQL Server dùng cổng nào?', previous, documents }).method, 'original');
  assert.equal(understand({ question: 'còn chức năng rác?', previous: { documentIds: ['deleted'] }, documents }).method, 'original');
  assert.equal(understand({ question: 'còn chức năng rác?', documents }).method, 'original');
});

test('claim check flags cited numbers, codes and links that the cited passage does not contain', () => {
  const evidence = [{ citationIndex: 1, payload: { fullText: 'Mở firewall port 1433. Mã lỗi SP_CREDENTIAL_INVALI\nD. Ngày phát hành 03 - 05 - 202 4' } },
    { citationIndex: 2, payload: { fullText: 'Tổng cộng ~12–17 ngày làm việc' } }];
  const supported = verifyClaims('SQL Server dùng cổng 1433 [1]. Lỗi SP_CREDENTIAL_INVALID [1], phát hành 03/05/2024 [1]. Mất 12-17 ngày [2].', evidence);
  assert.deepEqual(supported.unsupported, []);
  assert.ok(supported.checkedFacts >= 4);
  const wrong = verifyClaims('SQL Server dùng cổng 1434 [1].\n1. Mất 20 ngày [2]', evidence);
  assert.deepEqual(wrong.unsupported.map(item => item.facts), [['1434'], ['20']]);
  assert.deepEqual(verifyClaims('Năm 2025 không được đề cập [1].', evidence, 'Giá điện năm 2025?').unsupported, []);
  assert.deepEqual(verifyClaims('Cổng 9999 nhưng không trích dẫn.', evidence).unsupported, []);
});

test('BM25 keeps single digits so "phase 4" differs from "phase 2"', () => {
  const corpus = ['Phase 2 — Chất lượng tìm kiếm', 'Phase 4 — Mở rộng & Doanh nghiệp'].map((text, index) =>
    ({ id: `p:${index}`, text, payload: { documentId: 'p', chunkIndex: index, fullText: text } }));
  assert.equal(retrieval.bm25('phase 4 gồm gì', corpus, 2)[0].id, 'p:1');
});

test('GraphRAG is off unless enabled', t => {
  const before = process.env.GRAPHRAG_ENABLED;
  t.after(() => { if (before === undefined) delete process.env.GRAPHRAG_ENABLED; else process.env.GRAPHRAG_ENABLED = before; });
  delete process.env.GRAPHRAG_ENABLED;
  assert.equal(retrieval.graphRoute('Mối quan hệ giữa Qdrant và tài liệu là gì?'), false);
  process.env.GRAPHRAG_ENABLED = 'true';
  assert.equal(retrieval.graphRoute('Mối quan hệ giữa Qdrant và tài liệu là gì?'), true);
});

test('heading-only chunks are not informative', () => {
  assert.equal(retrieval.informative({ section: '21. Roadmap (cập nhật)', fullText: '21. Roadmap (cập nhật)\n# 21. Roadmap (cập nhật)' }), false);
  assert.equal(retrieval.informative({ section: 'Rác', fullText: 'Rác\n## Rác\nChức năng cho phép người dùng xem chi tiết Rác.' }), true);
});

test('search reports a vector outage as degraded keyword retrieval', async t => {
  const before = process.env.EMBEDDING_ENABLED;
  process.env.EMBEDDING_ENABLED = 'true';
  t.after(() => { if (before === undefined) delete process.env.EMBEDDING_ENABLED; else process.env.EMBEDDING_ENABLED = before; });
  t.mock.method(library, 'getDocuments', () => [{ id: 'guide', title: 'Guide', revision: 'r1' }]);
  t.mock.method(library, 'getChunks', () => [{ chunkIndex: 0, text: 'Đổi mật khẩu trong mục Cài đặt của ứng dụng' }]);
  t.mock.method(qdrant, 'request', async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
  const result = await retrieval.search('đổi mật khẩu', { documentIds: ['guide'], scopeMode: 'selected' });
  assert.equal(result.mode, 'lexical_degraded');
  assert.equal(result.vectorStatus, 'degraded');
  assert.equal(result.results.length, 1);
  assert.equal(rag.summarize(result).degraded, true);
});

test('a short passage is packed with its same-section neighbours', t => {
  t.mock.method(library, 'getChunks', () => [
    { chunkIndex: 3, section: '1.2 Database', text: '1.2 Database\nHệ thống dùng 3 hệ lưu trữ:' },
    { chunkIndex: 4, section: '1.2 Database', text: 'PostgreSQL | Metadata\nQdrant | Vector' },
    { chunkIndex: 5, section: '2. AI Provider', text: 'Provider Manager' }]);
  const [hit] = rag.expandNeighbours([{ payload: { documentId: 'kh', chunkIndex: 3, section: '1.2 Database', fullText: '1.2 Database\nHệ thống dùng 3 hệ lưu trữ:' } }]);
  assert.deepEqual(hit.payload.expandedWith, [4]);
  assert.match(hit.payload.fullText, /lưu trữ:\nPostgreSQL \| Metadata/);
  assert.doesNotMatch(hit.payload.fullText, /Provider Manager/);
  const packed = rag.pack([hit], 500);
  assert.match(packed.text, /^\[Tài liệu 1: Không tên · đoạn 4 · 1\.2 Database\]/);
});

test('previous document state is used only while valid and owned by the same account', () => {
  const state = { accountId: 'owner', question: 'App có gì', updatedAt: new Date().toISOString(), sources: [{ documentId: 'guide' }] };
  assert.deepEqual(rag.previousFromState(state, { accountId: 'owner' }), { question: 'App có gì', documentIds: ['guide'] });
  assert.equal(rag.previousFromState(state, { accountId: 'other' }), null);
  assert.equal(rag.previousFromState({ ...state, updatedAt: '2000-01-01T00:00:00Z' }, { accountId: 'owner' }), null);
});

test('heading-only chunks are merged into the chunk that follows', () => {
  const split = (text, max) => { const parts = []; for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max)); return parts; };
  const chunks = structured.chunks([
    { text: '# 3. Chuẩn bị hạ tầng', section: '3. Chuẩn bị hạ tầng' },
    { rows: [['Hạng mục', 'Chi tiết'], ['Mạng', 'Mở firewall port 1433']], section: '3.1 Kết nối kỹ thuật' },
    { text: 'Nội dung đầy đủ của mục bốn về checklist triển khai.', section: '4. Checklist' }], split);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].text, /^3\. Chuẩn bị hạ tầng\n[^]*3\.1 Kết nối kỹ thuật\nHạng mục/);
  assert.equal(chunks[0].rowStart, 2);
  assert.deepEqual(chunks.map(chunk => chunk.chunkIndex), [0, 1]);
});

test('reindex writes the new generation before removing the old one', async t => {
  const before = process.env.EMBEDDING_ENABLED;
  process.env.EMBEDDING_ENABLED = 'true';
  t.after(() => { if (before === undefined) delete process.env.EMBEDDING_ENABLED; else process.env.EMBEDDING_ENABLED = before; });
  t.mock.method(qdrant, 'ensureDocumentCollection', async () => 'documents');
  t.mock.method(qdrant, 'embedTexts', async texts => texts.map(() => [0.1, 0.2]));
  const calls = [];
  t.mock.method(qdrant, 'request', async (path, method, body) => { calls.push({ path, method, body }); return {}; });
  const result = await qdrant.indexDocumentChunks({ id: 'doc', title: 'Guide' }, [{ text: 'A' }, { text: 'B' }]);
  assert.equal(result.success, true);
  assert.equal(calls[0].method, 'PUT');
  const generation = calls[0].body.points[0].payload.indexGeneration;
  assert.ok(generation);
  assert.match(calls[1].path, /points\/delete/);
  assert.deepEqual(calls[1].body.filter.must_not, [{ key: 'indexGeneration', match: { value: generation } }]);

  calls.length = 0;
  qdrant.request.mock.mockImplementation(async (path, method, body) => {
    calls.push({ path, method, body });
    if (method === 'PUT') throw new Error('disk full');
    return {};
  });
  const failed = await qdrant.indexDocumentChunks({ id: 'doc', title: 'Guide' }, [{ text: 'A' }]);
  assert.equal(failed.success, false);
  assert.deepEqual(calls.at(-1).body.filter.must.at(-1).key, 'indexGeneration');
  assert.ok(!calls.some(call => call.body?.filter?.must_not), 'the old generation stays when the new one failed');
});

test('the knowledge base tool ranks passages of a named document instead of returning the whole file', async t => {
  t.mock.method(library, 'getDocuments', () => documents);
  const retrieve = t.mock.method(rag, 'retrieve', async () => ({ mode: 'hybrid', understanding: { method: 'file_name', documentIds: ['guide'] },
    results: [{ score: 0.03, payload: { documentId: 'guide', chunkIndex: 13, title: documents[0].title, fullText: 'Thay đổi mật khẩu: Cài đặt → Thay đổi mật khẩu' } }] }));
  const toolRegistry = require('../src/backend/intelligent_core/tool_registry');
  const previous = { question: 'q', documentIds: ['guide'] };
  const result = await toolRegistry._searchKnowledgeBase({ query: 'TPSOFT_HDSD_IPMS_APP__v1.0.docx đổi mật khẩu' }, { ragPrevious: previous });
  assert.equal(result.success, true);
  assert.equal(retrieve.mock.calls[0].arguments[0].previous, previous);
  assert.deepEqual(result.result.documents.map(document => [document.documentId, document.chunkIndex]), [['guide', 13]]);
  assert.equal(result.result.retrieval.method, 'file_name');
});

test('v2 document answers search the contract query inside the previous documents and pack within the budget', async t => {
  const memory = require('../src/backend/memory_core').memoryService;
  t.mock.method(memory, 'getSession', () => ({ documentState: { accountId: 'owner', question: 'App IPMS có gì',
    updatedAt: new Date().toISOString(), sources: [{ documentId: 'guide' }] } }));
  t.mock.method(library, 'getChunks', () => []);
  let toolArgs, toolContext, prompt;
  const toolManager = { executeTool: async (name, args, context) => { toolArgs = args; toolContext = context;
    return { success: true, result: { retrieval: { mode: 'hybrid', method: 'followup_scope' }, documents: [
      { documentId: 'guide', chunkIndex: 10, source: 'Guide', text: 'Đường ống: xem chi tiết Đường ống dẫn khí.' }] } }; } };
  const steps = [];
  const toolCalls = [];
  const result = await require('../src/backend/agent_core/pipeline/conversation_answer').searchDocuments({
    question: 'phần đường ống thì sao', contract: { kind: 'document', documentQuery: 'chức năng đường ống trong app IPMS' },
    conversation: [{ role: 'system', content: 'persona' }], plan: { outputs: { data: false } },
    context: { session: { id: 's', accountId: 'owner' } }, toolManager, toolContext: { allowedToolNames: ['search_knowledge_base'] }, toolCalls,
    dispatch: async (_tools, messages) => { prompt = messages[0].content; return { content: 'Xem chi tiết Đường ống dẫn khí [1].' }; },
    step: (type, data) => steps.push({ type, ...data }) });
  assert.equal(toolArgs.query, 'chức năng đường ống trong app IPMS');
  assert.deepEqual(toolContext.ragPrevious.documentIds, ['guide']);
  assert.match(prompt, /\[Tài liệu 1: Guide · đoạn 11\]\nĐường ống/);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(toolCalls[0].result.documents[0].citationIndex, 1);
  assert.equal(steps.find(step => step.type === 'V2_DOCUMENTS').retrieval.documentQuery, true);
  assert.equal(steps.find(step => step.type === 'RAG_CLAIMS_CHECKED').unsupported, 0);
});

test('golden-set scoring matches evidence without accents, spacing or punctuation', () => {
  const item = { id: 'c', category: 'direct', query: 'q', expect: { documentId: 'pdf', evidence: ['Tài liệu tích hợp'] } };
  assert.equal(scoring.isRelevant(item.expect, { documentId: 'pdf', fullText: 'Tài li ệ u tích h ợ p VNPT' }), true);
  assert.equal(scoring.isRelevant(item.expect, { documentId: 'other', fullText: 'Tài liệu tích hợp' }), false);
  const rows = [scoring.scoreCase(item, [{ payload: { documentId: 'pdf', fullText: 'khác' } }, { payload: { documentId: 'pdf', fullText: 'Tài liệu tích hợp' } }]),
    scoring.scoreCase({ id: 'n', category: 'no_answer', query: 'x', expect: null }, [])];
  const summary = scoring.summarize(rows);
  assert.equal(summary.overall.cases, 1);
  assert.equal(summary.overall.recallAt1, 0);
  assert.equal(summary.overall.recallAt5, 1);
  assert.equal(summary.overall.mrrAt10, 0.5);
  assert.throws(() => scoring.validateFixture({ cases: [{ id: 'a', query: 'q', expect: { documentId: 'replace-with-id' } }] }), /PLACEHOLDER/);
});

test('pipeline metrics count document turns, citation repairs and degraded retrieval', () => {
  const record = (id, payload, status = 'SUCCESS') => ({ id, timestamp: '2026-10-26T08:00:00Z', status, latencyMs: 4000, requestPayload: payload });
  const metrics = computeMetrics([
    record('a', { contextSelection: { mode: 'knowledge', rag: { mode: 'hybrid', method: 'original', found: 3 } },
      citationValidation: { unsupportedClaims: [{ facts: ['1434'] }] } }),
    record('b', { diagnostics: { pipeline: 'v2', v2Contract: { kind: 'document' }, steps: [
      { type: 'MODEL_USAGE', stage: 'v2_document_repair' },
      { type: 'V2_DOCUMENTS', found: 0, retrieval: { mode: 'lexical_degraded', degraded: true, method: 'followup_scope' } }] } }, 'PARTIAL'),
    record('c', { contextSelection: { mode: 'general' }, toolCalls: [{ name: 'search_knowledge_base' }] })]);
  assert.equal(metrics.rag.total, 2);
  assert.equal(metrics.rag.partialRate, 0.5);
  assert.equal(metrics.rag.citationRepairRate, 0.5);
  assert.equal(metrics.rag.emptyRetrievalRate, 0.5);
  assert.equal(metrics.rag.degradedRate, 0.5);
  assert.equal(metrics.rag.unsupportedClaimRate, 1);
  assert.deepEqual(metrics.rag.methods.map(item => item.name).sort(), ['followup_scope', 'original']);
});

test('grouped citation markers count as one marker per source', () => {
  const citations = require('../src/backend/knowledge_core/services/citation_service');
  assert.equal(citations.splitGroupedMarkers('Dùng Qdrant [1, 3, 4]. Xem thêm [2;5] và [6].'), 'Dùng Qdrant [1][3][4]. Xem thêm [2][5] và [6].');
  assert.deepEqual(citations.findMarkers('Dùng Qdrant [1, 3].'), [1, 3]);
  assert.equal(citations.splitGroupedMarkers('Mảng [1, 2](https://x)'), 'Mảng [1, 2](https://x)');
});

test('a v2 document answer with grouped markers is accepted without a repair call', async () => {
  const stages = [];
  const result = await require('../src/backend/agent_core/pipeline/conversation_answer').documents({
    conversation: [{ role: 'user', content: 'q' }], plan: { outputs: { data: false } },
    context: { knowledgeGrounding: { required: true }, citationEvidence: [{ citationIndex: 1 }, { citationIndex: 3 }] },
    dispatch: async (_tools, _messages, stage) => { stages.push(stage); return { content: 'KnowledgeHub dùng Qdrant [1, 3].' }; } });
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.reply, 'KnowledgeHub dùng Qdrant [1][3].');
  assert.deepEqual(stages, ['v2_document']);
});
