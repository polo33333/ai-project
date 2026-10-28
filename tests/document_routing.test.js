'use strict';
// Routing between documents, data and conversation in the v2 pipeline
// (routing plan of 26/10/2026): document signal, LIBRARY prompt, gate and chat rescue.
const test = require('node:test');
const assert = require('node:assert/strict');
const signal = require('../src/backend/knowledge_core/rag/signal');
const pipeline = require('../src/backend/agent_core/pipeline/contract_pipeline');
const library = require('../src/backend/knowledge_core/services/library_service');
const qdrant = require('../src/backend/services/qdrant_service');

const guide = { id: 'guide', title: 'TPSOFT_HDSD_IPMS_APP__v1.0.docx', preview: 'HƯỚNG DẪN SỬ DỤNG   ỨNG DỤNG QUẢN LÝ KCN IPMS' };
const plan = { id: 'plan', title: 'Phase1_SQLServer_Connector_Plan.docx', preview: 'Phase 1: SQL Server Knowledge Connector' };

function embedding(t, value) {
  const before = process.env.EMBEDDING_ENABLED;
  process.env.EMBEDDING_ENABLED = value;
  t.after(() => { if (before === undefined) delete process.env.EMBEDDING_ENABLED; else process.env.EMBEDDING_ENABLED = before; });
}

test('the document signal is strong for a file name, words addressed to the library, or a high passage score', async t => {
  embedding(t, 'true');
  let score = 0.7;
  t.mock.method(qdrant, 'searchDocuments', async () => ({ status: 'ok', results: [{ score, payload: { documentId: 'guide' } }] }));
  const documents = [guide, plan];
  assert.deepEqual(await signal.documentSignal('Đổi mật khẩu trên app thế nào', { documents, threshold: 0.6 }),
    { strength: 'strong', reason: 'score', score: 0.7, threshold: 0.6, vectorStatus: 'ok', documentId: 'guide', title: guide.title, blocked: null });
  score = 0.45;
  assert.equal((await signal.documentSignal('Có bao nhiêu phản ánh đang xử lý?', { documents, threshold: 0.6 })).strength, 'weak');
  assert.equal((await signal.documentSignal('Phase1_SQLServer_Connector_Plan.docx', { documents })).reason, 'file_name');
  assert.equal((await signal.documentSignal('Phase1_SQLServer_Connector_Plan.docx', { documents })).documentId, 'plan');
  assert.equal((await signal.documentSignal('Theo tài liệu công ty, nghỉ phép năm bao nhiêu ngày?', { documents })).reason, 'explicit');
  assert.equal((await signal.documentSignal('kho tri thức: cách tải app', { documents })).reason, 'explicit');
  assert.equal((await signal.documentSignal('xuất tài liệu này ra excel', { documents })).strength, 'weak');
  assert.equal((await signal.documentSignal('bất kỳ', { documents: [] })).strength, 'none');
});

test('without embeddings only a file name or library words make the signal strong', async t => {
  embedding(t, 'false');
  const vector = t.mock.method(qdrant, 'searchDocuments', async () => { throw new Error('Vector forbidden'); });
  const result = await signal.documentSignal('Đổi mật khẩu trên app thế nào', { documents: [guide] });
  assert.equal(result.strength, 'weak');
  assert.equal(result.score, null);
  assert.equal(vector.mock.callCount(), 0);
});

test('the routing threshold comes from RAG_ROUTING_MIN_SCORE and falls back to 0.6', t => {
  const before = process.env.RAG_ROUTING_MIN_SCORE;
  t.after(() => { if (before === undefined) delete process.env.RAG_ROUTING_MIN_SCORE; else process.env.RAG_ROUTING_MIN_SCORE = before; });
  process.env.RAG_ROUTING_MIN_SCORE = '0.65';
  assert.equal(signal.minScore(), 0.65);
  process.env.RAG_ROUTING_MIN_SCORE = 'abc';
  assert.equal(signal.minScore(), 0.6);
});

test('LIBRARY lists the documents the model may receive, best match first, only when documents can be searched', t => {
  t.mock.method(signal, 'routableDocuments', () => [guide, plan]);
  const strong = { strength: 'strong', documentId: 'plan' };
  const entries = JSON.parse(pipeline.libraryPrompt({ allowedToolNames: ['search_knowledge_base'] }, strong));
  assert.deepEqual(entries.map(entry => entry.title), [plan.title, guide.title]);
  assert.equal(entries[0].bestMatch, true);
  assert.equal(entries[1].about, 'HƯỚNG DẪN SỬ DỤNG ỨNG DỤNG QUẢN LÝ KCN IPMS');
  assert.equal(pipeline.libraryPrompt({ allowedToolNames: ['execute_sql_query'] }, strong), '');
});

const table = { tableId: 's::testrows', tableName: 'TestRows', schemaName: 'dbo', dbSourceId: 's', isActive: true,
  columns: [{ columnName: 'ID', dataType: 'INT', isPrimaryKey: true, displayName: 'ID' }, { columnName: 'Qty', dataType: 'FLOAT', displayName: 'Sản lượng' }] };

async function route(t, { gate, strength, kind = 'chat', blocked = null }) {
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [table]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  t.mock.method(signal, 'documentSignal', async () => ({ strength, reason: strength === 'strong' ? 'score' : 'below_threshold', score: strength === 'strong' ? 0.7 : 0.4, threshold: 0.6, documentId: 'guide', blocked }));
  t.mock.method(signal, 'routableDocuments', () => [guide]);
  t.mock.method(library, 'getChunks', () => []);
  const calls = [], stages = [], prompts = [];
  const toolManager = { executeTool: async (name, args) => {
    calls.push(name);
    if (name === 'search_schema') return { success: true, result: gate === 'data'
      ? { mode: 'data', dbSourceId: 's', selectedTables: ['TestRows'], tableDirectory: [{ tableName: 'TestRows' }], intentCatalog: [{ tableName: 'TestRows', columns: [] }], tables: [] }
      : { mode: 'general' } };
    if (name === 'search_knowledge_base') return { success: true, result: { retrieval: { mode: 'hybrid' }, documents: [
      { documentId: 'guide', chunkIndex: 13, source: guide.title, text: 'Từ màn hình trang chủ → Cài đặt → Thay đổi mật khẩu.' }] } };
    return { success: false, error: `unexpected ${name} ${JSON.stringify(args)}` };
  } };
  const dispatch = async (definitions, messages, stage) => {
    stages.push(stage); prompts.push(messages.map(message => message.content).join('\n'));
    if (definitions[0]?.function?.name === 'plan_query') return { tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query',
      arguments: JSON.stringify(kind === 'data' ? { kind: 'data', root: 'TestRows', operation: 'aggregate', measures: [{ ref: 'TestRows.Qty', aggregation: 'SUM' }] } : { kind }) } }] };
    return { content: stage.startsWith('v2_document') ? 'Vào Cài đặt → Thay đổi mật khẩu [1].' : 'Chào bạn.' };
  };
  const trace = { steps: [] };
  let result;
  try {
    result = await pipeline.run({ question: 'Đổi mật khẩu trên app thế nào?', plan: { outputs: { data: false } }, context: { session: {} }, dispatch, toolManager, trace,
      toolCalls: [], requestTime: { today: '2026-10-26' }, conversation: [{ role: 'system', content: 'persona' }],
      toolContext: { allowedToolNames: ['search_schema', 'execute_sql_query', 'search_knowledge_base'], dbSourceId: 's', modelDestination: { id: 'cloud', local: false } } });
  } catch (error) { result = { error }; }
  return { result, calls, stages, prompts, routing: trace.steps.filter(step => step.type === 'ROUTING_DECISION') };
}

test('a strong signal answers from documents when the keyword gate says conversation, without the plan_query call', async t => {
  const { result, stages, routing } = await route(t, { gate: 'general', strength: 'strong' });
  assert.equal(result.contract.kind, 'document');
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.reply, /\[1\]/);
  assert.ok(!stages.includes('v2_contract'));
  assert.deepEqual(routing.map(step => [step.gate, step.final, step.override]), [['general', 'document', 'gate_to_document']]);
});

test('a weak signal keeps the keyword gate decision: conversation', async t => {
  const { result, calls, stages, routing } = await route(t, { gate: 'general', strength: 'weak' });
  assert.equal(result.reply, 'Chào bạn.');
  assert.ok(!calls.includes('search_knowledge_base'));
  assert.deepEqual(stages, ['v2_chat']);
  assert.deepEqual(routing.map(step => [step.final, step.override]), [['chat', null]]);
});

test('a strong signal rescues a chat choice of the model and LIBRARY marks the best match', async t => {
  const { result, prompts, routing } = await route(t, { gate: 'data', strength: 'strong', kind: 'chat' });
  assert.equal(result.contract.kind, 'document');
  assert.match(prompts[0], /LIBRARY \(company documents for kind=document[^\n]*"bestMatch":true/);
  assert.deepEqual(routing.map(step => [step.modelKind, step.final, step.override]), [['chat', 'document', 'chat_to_document']]);
});

test('a strong signal never overrides a data choice; the disagreement is recorded', async t => {
  const { calls, routing } = await route(t, { gate: 'data', strength: 'strong', kind: 'data' });
  assert.ok(!calls.includes('search_knowledge_base'));
  assert.equal(routing[0].modelKind, 'data');
  assert.equal(routing[0].final, 'data');
  assert.equal(routing[0].conflict, true);
});

test('a weak signal leaves the model chat choice as conversation', async t => {
  const { result, calls, routing } = await route(t, { gate: 'data', strength: 'weak', kind: 'chat' });
  assert.equal(result.contract.kind, 'chat');
  assert.ok(!calls.includes('search_knowledge_base'));
  assert.deepEqual(routing.map(step => [step.final, step.override, step.conflict]), [['chat', null, false]]);
});

test('pipeline metrics show where questions were routed and how often the signal changed it', () => {
  const { computeMetrics } = require('../src/backend/training_core/pipeline_metrics');
  const record = (id, routing) => ({ id, timestamp: '2026-10-26T08:00:00Z', status: 'SUCCESS', latencyMs: 1000,
    requestPayload: { diagnostics: { pipeline: 'v2', steps: [{ type: 'ROUTING_DECISION', ...routing }] } } });
  const metrics = computeMetrics([
    record('a', { gate: 'general', final: 'document', override: 'gate_to_document', signal: { strength: 'strong' } }),
    record('b', { gate: 'data', modelKind: 'chat', final: 'document', override: 'chat_to_document', signal: { strength: 'strong' } }),
    record('c', { gate: 'data', modelKind: 'data', final: 'data', override: null, conflict: true, signal: { strength: 'strong' } }),
    record('d', { gate: 'general', final: 'chat', override: null, signal: { strength: 'weak' } })]);
  assert.equal(metrics.routing.total, 4);
  assert.equal(metrics.routing.overrides, 2);
  assert.equal(metrics.routing.overrideRate, 0.5);
  assert.equal(metrics.routing.conflicts, 1);
  assert.deepEqual(metrics.routing.finals.map(item => [item.name, item.count]), [['document', 2], ['chat', 1], ['data', 1]]);
});

const smartca = { id: 'smartca', title: 'Kich_ban_tich_hop_smartca_v4.1_thuong.pdf', governedPolicy: { schemaVersion: 2, aiSharing: { level: 'local' } } };
const withheld = { reason: 'score', score: 0.71, documents: [{ documentId: 'smartca', title: smartca.title, sensitivity: 'internal' }] };

test('the signal reports a better match in a document the model may not receive', async t => {
  embedding(t, 'true');
  const publicGuide = { ...guide, governedPolicy: { sensitivity: 'public' } };
  t.mock.method(library, 'getDocuments', () => [publicGuide, smartca]);
  let results = [{ score: 0.71, payload: { documentId: 'smartca' } }, { score: 0.5, payload: { documentId: 'guide' } }];
  const search = t.mock.method(qdrant, 'searchDocuments', async () => ({ status: 'ok', results }));
  const cloud = { id: 'cloud', local: false };
  const weak = await signal.documentSignal('Địa chỉ service UAT của SmartCA', { modelDestination: cloud, threshold: 0.6 });
  assert.deepEqual(search.mock.calls[0].arguments[2].documentIds, ['guide', 'smartca']);
  assert.equal(weak.strength, 'weak');
  assert.equal(weak.score, 0.5);
  assert.deepEqual(weak.blocked, { reason: 'score', score: 0.71, documents: [{ documentId: 'smartca', title: smartca.title, sensitivity: 'internal' }] });
  results = [{ score: 0.72, payload: { documentId: 'smartca' } }, { score: 0.66, payload: { documentId: 'guide' } }];
  const both = await signal.documentSignal('Ký số trên app', { modelDestination: cloud, threshold: 0.6 });
  assert.equal(both.strength, 'strong');
  assert.equal(both.blocked.documents[0].documentId, 'smartca');
  results = [{ score: 0.66, payload: { documentId: 'guide' } }, { score: 0.64, payload: { documentId: 'smartca' } }];
  assert.equal((await signal.documentSignal('Đổi mật khẩu', { modelDestination: cloud, threshold: 0.6 })).blocked, null);
  assert.equal((await signal.documentSignal('Tóm tắt Kich_ban_tich_hop_smartca_v4.1_thuong.pdf', { modelDestination: cloud })).blocked.reason, 'file_name');
  // A local model may receive internal documents; nothing is blocked.
  assert.equal((await signal.documentSignal('Địa chỉ service UAT của SmartCA', { modelDestination: { id: 'ollama', local: true } })).blocked, null);
});

test('the notice names the document and the model, never a restricted title', t => {
  t.mock.method(require('../src/backend/services/ai_provider_manager'), 'getProviderForExecution', () => ({ name: 'Google Gemini - Payment' }));
  const { blockedNotice } = require('../src/backend/agent_core/pipeline/conversation_answer');
  const text = blockedNotice(withheld, { id: 'cloud', local: false });
  assert.match(text, /“Kich_ban_tich_hop_smartca_v4\.1_thuong\.pdf”/);
  assert.match(text, /chưa được phép gửi cho mô hình đang dùng \(Google Gemini - Payment\)/);
  assert.match(text, /mô hình chạy trên máy/);
  const restricted = blockedNotice({ reason: 'score', score: 0.7, documents: [{ documentId: 'x', title: 'Bí mật.docx', sensitivity: 'restricted' }] }, { id: 'cloud', local: false });
  assert.doesNotMatch(restricted, /Bí mật|chạy trên máy/);
  assert.match(restricted, /tài liệu trong thư viện/);
});

test('when only withheld documents match, the user gets the notice without a model call', async t => {
  const { result, calls, stages, routing } = await route(t, { gate: 'general', strength: 'weak', blocked: withheld });
  assert.equal(result.status, 'DOCUMENT_NOT_PERMITTED');
  assert.match(result.reply, /chưa được phép gửi/);
  assert.deepEqual(stages, []);
  assert.ok(!calls.includes('search_knowledge_base'));
  assert.deepEqual(routing.map(step => [step.final, step.override]), [['document_blocked', 'gate_to_blocked_notice']]);
});

test('a model chat choice with a withheld match also gets the notice', async t => {
  const { result, stages, routing } = await route(t, { gate: 'data', strength: 'weak', kind: 'chat', blocked: withheld });
  assert.equal(result.status, 'DOCUMENT_NOT_PERMITTED');
  assert.deepEqual(stages, ['v2_contract']);
  assert.deepEqual(routing.map(step => [step.final, step.override]), [['document_blocked', 'chat_to_blocked_notice']]);
});

test('permitted documents still answer when they match; a better withheld match adds a note', async t => {
  const { result, routing } = await route(t, { gate: 'general', strength: 'strong', blocked: withheld });
  assert.equal(result.status, 'SUCCESS');
  assert.match(result.reply, /^Vào Cài đặt → Thay đổi mật khẩu \[1\]\.\n\n_Nội dung bạn hỏi có trong tài liệu “Kich_ban/);
  assert.equal(routing[0].signal.blocked.documentIds[0], 'smartca');
});
