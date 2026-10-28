'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/backend/assistant/core');
const providers = require('../src/backend/services/ai_provider_manager');
const schema = require('../src/backend/assistant/schema_context_service');
const connector = require('../src/backend/services/sql_connector');
const { trainingService } = require('../src/backend/training');
const fixture = require('./fixtures/provider_raw_contract_chat.json');

test('ordinary chat uses only the selected model without schema or document embedding', async t => {
  const selected = { id: 'chosen', name: 'Chosen cloud', model: 'chosen-model', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', id => id === selected.id ? selected : null);
  t.mock.method(providers, 'getActiveProvider', () => ({ ...selected, id: 'other', model: 'other-model' }));
  const embeddings = t.mock.method(require('../src/backend/services/qdrant_service'), 'embedTexts', async () => { throw new Error('Embedding must not be called'); });
  t.mock.method(require('../src/backend/knowledge/services/library_service'), 'getDocuments', () => []);
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, model: request.model });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'A spreadsheet organizes information into rows and columns.' }, finish_reason: 'stop' }] }) };
  });
  const result = await core.chat('Hướng dẫn sử dụng Excel và giải thích chi tiết cách xuất file PDF', { providerId: selected.id, useTools: false });
  assert.equal(result.success, true);
  assert.equal(embeddings.mock.callCount(), 0);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.model === selected.model && call.url.startsWith(selected.baseUrl)));
});

test('selected local chat model never falls back to another installed local model', async t => {
  const selected = { id: 'chosen-local', name: 'Chosen local', model: 'chosen-local-model', type: 'local', apiFormat: 'ollama',
    executionClass: 'local', baseUrl: 'http://127.0.0.1:11434' };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(providers, 'getProvidersForExecution', () => [selected, { ...selected, id: 'other-local', model: 'other-local-model', baseUrl: 'http://127.0.0.1:11500' }]);
  t.mock.method(schema, 'buildSchemaContext', async () => ({ mode: 'general', selectedTables: [], schemaContext: '', useTools: false }));
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => { calls.push({ url, model: JSON.parse(options.body).model }); throw new Error('connect ECONNREFUSED'); });
  const result = await core.chat('Explain spreadsheets', { providerId: selected.id, knowledgeSearchEnabled: false, useTools: false });
  assert.ok(calls.length);
  assert.ok(calls.every(call => call.model === selected.model && call.url.startsWith(selected.baseUrl)));
  assert.equal(result.usedProvider.id, selected.id);
});

test('default chat model is resolved before routing and stays pinned when the active provider changes', async t => {
  const selected = { id: 'default-before', name: 'Default before', model: 'before-model', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://before.invalid' };
  let active = selected;
  t.mock.method(providers, 'getActiveProvider', () => active);
  t.mock.method(schema, 'buildSchemaContext', async () => ({ mode: 'general', selectedTables: [], schemaContext: '', useTools: false }));
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, model: JSON.parse(options.body).model });
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'A spreadsheet stores information in cells.' }, finish_reason: 'stop' }] }) };
  });
  const result = await core.chat('Explain spreadsheets', { knowledgeSearchEnabled: false, useTools: false });
  assert.ok(calls.length);
  assert.ok(calls.every(call => call.model === selected.model && call.url.startsWith(selected.baseUrl)));
  assert.equal(result.usedProvider.id, selected.id);
});

for (const flags of [{ AI_PROVIDER_GUARDS_ENABLED: 'true' }, { AI_PROVIDER_GUARDS_ENABLED: 'false' }]) {
  test(`explicit model selection never falls back to another provider (${JSON.stringify(flags)})`, async t => {
    const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
    Object.assign(process.env, flags);
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const selected = { id: 'chosen', name: 'Chosen cloud', model: 'chosen-model', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
    t.mock.method(providers, 'getProviderForExecution', id => id === selected.id ? selected : null);
    t.mock.method(providers, 'getActiveProvider', () => selected);
    t.mock.method(providers, 'getProvidersForExecution', () => [selected, { ...selected, id: 'local', model: 'local-model', baseUrl: 'http://127.0.0.1:11434' }]);
    t.mock.method(schema, 'buildSchemaContext', async () => ({ mode: 'general', selectedTables: [], schemaContext: '', useTools: false }));
    const calls = [];
    t.mock.method(global, 'fetch', async url => { calls.push(url); throw new Error('connect ECONNREFUSED'); });
    const result = await core.chat('Hello there', { providerId: selected.id, knowledgeSearchEnabled: false, useTools: false });
    assert.notEqual(result.completionStatus, 'SUCCESS');
    assert.ok(calls.length > 0);
    assert.ok(calls.every(url => url.startsWith(selected.baseUrl)), JSON.stringify(calls));
  });
}

test('web chat bypasses database schema retrieval before calling the cloud provider', async t => {
  const provider = { id: 'web-cloud', name: 'Fixture cloud', model: 'fixture', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://test.invalid' };
  t.mock.method(providers, 'getActiveProvider', () => provider);
  t.mock.method(providers, 'getProvidersForExecution', () => [provider]);
  const retrieval = t.mock.method(schema, 'buildSchemaContext', async () => { throw new Error('Schema embedding must not be called'); });
  const web = require('../src/backend/services/web_search_service');
  t.mock.method(web, 'search', async () => [{ title: 'Cloud models', url: 'https://example.com/models', snippet: 'Cloud models answer questions remotely.' }]);
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({
    choices: [{ message: { content: 'Cloud models answer questions remotely.' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }) }));
  const result = await core.chat('Search the web for information about cloud models', { webSearch: true, knowledgeSearchEnabled: false, useTools: false });
  assert.equal(result.success, true);
  assert.equal(retrieval.mock.callCount(), 0);
  assert.match(result.replyText, /Cloud models/);
});

test('selected knowledge bypasses workflow/schema and excludes old history even without hits', async t => {
  const documents = require('../src/backend/knowledge/services/retrieval_service');
  const selected = { id: 'knowledge-test', name: 'Knowledge', model: 'test', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid', supportsToolCalling: true };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  const schemaCalls = t.mock.method(schema, 'buildSchemaContext', async () => { throw new Error('No schema retrieval'); });
  t.mock.method(require('../src/backend/knowledge/services/library_service'), 'getDocuments', () => []);
  let hits = [];
  let expectedSources;
  t.mock.method(documents, 'search', async (_, options) => {
    assert.deepEqual(options.documentIds, expectedSources);
    assert.equal(options.scopeMode, expectedSources.length ? 'selected' : 'all_authorized');
    return { results: hits, mode: 'hybrid' };
  });
  const requests = [];
  t.mock.method(require('../src/backend/agent/harness/guarded_agent_harness').prototype, 'run', async request => {
    requests.push(request);
    return { replyText: 'Hướng dẫn tải app [1]', toolCalls: [], tokenUsage: { available: false } };
  });
  for (const sourceIds of [['selected-doc']]) {
  expectedSources = sourceIds;
  for (const found of [false, true]) {
    hits = found ? [{ payload: { title: 'IPMS', fullText: 'Tải IPMS từ cửa hàng ứng dụng.', chunkIndex: 0 } }] : [];
    const result = await core.chat('tìm trong kho tri thức: cách tải app', { providerId: selected.id, knowledgeSourceIds: sourceIds, history: [{ role: 'user', content: 'OLD_HISTORY_SENTINEL' }], permissions: ['knowledge:read'] });
    assert.equal(result.trace.workflowRouting.decisionSource, 'selected_knowledge');
    const request = requests.at(-1);
    assert.equal(request.context.mode, 'knowledge');
    assert.deepEqual(request.enabledToolNames, []);
    assert.deepEqual(request.context.selectedTables, []);
    assert.equal(request.messages.length, 2);
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD_HISTORY_SENTINEL/);
    assert.match(request.messages[0].content, found ? /IPMS/ : /No matching document passages/);
  }
  }
  assert.equal(schemaCalls.mock.callCount(), 0);
});

test('selected document follow-up persists ordered evidence and resolves it for retrieval and prompt', async t => {
  const memory = require('../src/backend/memory').memoryService;
  const library = require('../src/backend/knowledge/services/library_service');
  const retrieval = require('../src/backend/knowledge/services/retrieval_service');
  const selected = { id: 'followup-test', name: 'Knowledge', model: 'test', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(library, 'getDocuments', () => [{ id: 'followup-doc', revision: 'r1' }]);
  const queries = [];
  t.mock.method(retrieval, 'search', async (query, options) => {
    queries.push(query);
    assert.deepEqual(options.documentIds, ['followup-doc']);
    return { results: [{ payload: { documentId: 'followup-doc', title: 'Đăng ký', revision: 'r1', chunkId: 'followup-doc:r1:0', chunkIndex: 0,
      fullText: 'Hồ sơ cần HD001 và HD002. Thiếu HD002 thì bổ sung.' } }], mode: 'hybrid' };
  });
  const requests = [];
  t.mock.method(require('../src/backend/agent/harness/guarded_agent_harness').prototype, 'run', async request => {
    requests.push(request);
    return { replyText: requests.length === 1 ? '1. HD001 [1]\n2. HD002 [1]' : 'Thiếu HD002 thì bổ sung [1]',
      toolCalls: [], trace: { completionStatus: 'SUCCESS', training: { responseEvaluation: { valid: true } } } };
  });
  const options = { providerId: selected.id, knowledgeSourceIds: ['followup-doc'],
    session: { id: 'followup-quality-session', accountId: 'owner' }, permissions: ['knowledge:read'] };
  t.after(() => memory.clearSession(options.session.id, 'owner'));
  await core.chat('Đăng ký cần giấy tờ gì?', options);
  assert.equal(memory.getSession(options.session.id, false, 'owner').documentState.lists[0][1].ordinal, 2);
  const result = await core.chat('Cái thứ hai nếu thiếu thì sao?', { ...options, history: [{ role: 'assistant', content: 'OLD_UNVERIFIED_HISTORY' }] });
  assert.equal(result.question, 'Cái thứ hai nếu thiếu thì sao?');
  assert.match(queries[1], /HD002/);
  assert.doesNotMatch(queries[1], /HD001/);
  assert.match(requests[1].messages[0].content, /Tham chiếu đã giải/);
  assert.equal(requests[1].messages.length, 2);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /OLD_UNVERIFIED_HISTORY/);
  const ambiguous = await core.chat('Cái thứ năm thì sao?', options);
  assert.equal(ambiguous.answerDisposition, 'clarify');
  assert.equal(queries.length, 2);
  assert.equal(requests.length, 2);
  await core.chat('Hướng dẫn hủy hồ sơ?', options);
  assert.equal(queries.at(-1), 'Hướng dẫn hủy hồ sơ?');
});

for (const pageInfo of [
  { pageCount: 8, pageCountSource: 'pdf_pages' },
  { pageCount: 12, pageCountSource: 'word_saved_metadata' }, null
]) {
test(`document page-count follow-up resolves the actually cited document (${pageInfo?.pageCountSource || 'unknown'})`, async t => {
  const memory = require('../src/backend/memory').memoryService;
  const library = require('../src/backend/knowledge/services/library_service');
  const retrieval = require('../src/backend/knowledge/services/retrieval_service');
  const provider = { id: 'doc-metadata-test', name: 'Knowledge', model: 'test', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', () => provider);
  t.mock.method(providers, 'getActiveProvider', () => provider);
  const docs = [{ id: 'app-manual', title: 'IPMS.docx', revision: 'r1', fileType: 'DOCX' }, { id: 'other', title: 'Other.pdf', revision: 'r2' }];
  t.mock.method(library, 'getDocuments', () => docs);
  t.mock.method(library, 'getPageInfo', id => { assert.equal(id, 'app-manual'); return pageInfo; });
  const search = t.mock.method(retrieval, 'search', async () => ({ results: docs.map(document => ({ payload: {
    documentId: document.id, title: document.title, revision: document.revision, chunkIndex: 0,
    chunkId: `${document.id}:${document.revision}:0`, fullText: 'Tải ứng dụng từ Google Play hoặc App Store.'
  } })), mode: 'hybrid' }));
  const harness = t.mock.method(require('../src/backend/agent/harness/guarded_agent_harness').prototype, 'run', async () => ({
    replyText: '1. Android:\n- Cài từ Google Play [1]\n2. iOS:\n- Cài từ App Store [1]', toolCalls: [],
    trace: { completionStatus: 'SUCCESS', training: { responseEvaluation: { valid: true } } }
  }));
  const options = { providerId: provider.id, session: { id: `page-followup-${pageInfo?.pageCount || 'unknown'}`, accountId: 'owner' }, permissions: ['knowledge:read'] };
  t.after(() => memory.clearSession(options.session.id, 'owner'));
  // Both turns keep the user's document selection; the follow-up names no document.
  const scoped = { ...options, knowledgeSourceIds: docs.map(document => document.id) };
  await core.chat('Hướng dẫn tải ứng dụng IPMS', scoped);
  const question = pageInfo?.pageCountSource === 'word_saved_metadata' ? 'tl trên có mấy trang' : 'tài liệu trên có mấy trang';
  const result = await core.chat(question, scoped);
  assert.equal(result.success, true);
  assert.match(result.replyText, /IPMS\.docx/);
  assert.notEqual(result.answerDisposition, 'clarify');
  assert.equal(search.mock.callCount(), 1);
  assert.equal(harness.mock.callCount(), 1);
  if (pageInfo) {
    assert.match(result.replyText, new RegExp(`${pageInfo.pageCount} trang`));
    assert.equal(result.citations[0].documentId, 'app-manual');
  } else {
    assert.equal(result.answerDisposition, 'no_evidence');
    assert.match(result.replyText, /chưa có thông tin số trang đáng tin cậy/);
    assert.doesNotMatch(result.replyText, /\d+ trang/);
  }
  if (pageInfo?.pageCountSource === 'word_saved_metadata') assert.match(result.replyText, /có thể thay đổi/);
});
}

