'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/backend/intelligent_core/core');
const providers = require('../src/backend/services/ai_provider_manager');
const schema = require('../src/backend/intelligent_core/schema_context_service');
const connector = require('../src/backend/services/sql_connector');
const { trainingService } = require('../src/backend/training_core');
const fixture = require('./fixtures/provider_raw_contract_chat.json');
test.beforeEach(t => {
  t.mock.method(require('../src/backend/automation/chat_router'), 'classifyFlow', async () => ({ flow: 'chat' }));
});

test('a contract attribute follow-up uses verified workflow data and bypasses automatic document/schema retrieval', async t => {
  const memory = require('../src/backend/memory_core').memoryService;
  const previous = { runId: 'contract-run', templateId: 'contracts/detail', name: 'Contract details',
    table: null, dbSourceId: 'test-db', inputs: { query: 'HD001' },
    datasets: [{ field: 'contracts', rowCount: 1, columns: ['ContractNo', 'TotalArea'],
      preview: [{ ContractNo: 'HD001', TotalArea: 32451.95 }] }], result: {} };
  t.mock.method(memory, 'getSession', () => ({ lastWorkflowRun: previous, lastPlan: { table: 'T_Contract' }, messages: [] }));
  t.mock.method(memory, 'getLegacyContext', () => []);
  t.mock.method(memory, 'route', () => ({ mode: 'recent', currentScope: 'contract', maxMessages: 2 }));
  t.mock.method(memory, 'getContext', () => { throw new Error('Unverified old replies must not replace the completed result'); });
  t.mock.method(require('../src/backend/automation/conversation_memory'), 'readRun', async () => ({}));
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async (_, options) => {
    options.routingContext.decision = { route: 'chat', memoryFollowup: true };
    return null;
  });
  const selected = { id: 'contract-chat', name: 'Contract chat', model: 'chosen-model', apiFormat: 'openai',
    executionClass: 'remote', baseUrl: 'https://chosen.invalid', supportsToolCalling: true };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(connector, 'getDefaultDbSource', () => ({ id: 'test-db', dbName: 'Fixture' }));
  const schemaCalls = t.mock.method(schema, 'buildSchemaContext', async () => { throw new Error('No schema retrieval'); });
  const documents = require('../src/backend/knowledge_core/services/retrieval_service');
  const documentCalls = t.mock.method(documents, 'search', async () => { throw new Error('No automatic document retrieval'); });
  t.mock.method(require('../src/backend/knowledge_core/services/library_service'), 'getDocuments', () => [{ title: 'Tổng diện tích IPMS.docx' }]);
  t.mock.method(global, 'fetch', async (_, options) => {
    const request = JSON.parse(options.body);
    assert.match(JSON.stringify(request.messages), /32451\.95/);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hợp đồng HD001 có tổng diện tích 32451.95.' }, finish_reason: 'stop' }] }) };
  });
  const result = await core.chat('hợp đồng trên có tổng diện tích bao nhiêu', { providerId: selected.id,
    session: { id: 'contract-session', accountId: 'owner' }, permissions: ['admin'] });
  assert.equal(result.success, true);
  assert.match(result.replyText, /32451\.95/);
  assert.equal(schemaCalls.mock.callCount(), 0);
  assert.equal(documentCalls.mock.callCount(), 0);
  assert.equal(result.contextSelection.knowledgeMode, 'skipped_verified_workflow');
});

for (const databaseAvailable of [true, false]) {
test(`ds kh avoids embedding and model retries (database available: ${databaseAvailable})`, async t => {
  const dictionary = require('../src/backend/services/dictionary_service');
  const automation = require('../src/backend/automation');
  const table = require('../src/backend/services/schema_identity').withIdentity({ dbSourceId: 'test-db', dbName: 'Fixture', schemaName: 'sales', tableName: 'M_Customer', domain: 'customer', isActive: true,
    columns: [{ columnName: 'CustomerID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'CustomerName', dataType: 'NVARCHAR' }, { columnName: 'Password', dataType: 'NVARCHAR' }] });
  t.mock.method(dictionary, 'getGroupedTables', () => [table]);
  t.mock.method(dictionary, 'getTableRelationships', () => []);
  t.mock.method(dictionary, 'getGlossary', () => [{ term: 'KH', fullMeaning: 'Khách hàng', isActive: true }]);
  t.mock.method(require('../src/backend/intelligent_core/domain_alias_service'), 'getDomainAliases', () => ({ customer: ['khach hang'] }));
  // With workflows disabled, reviewed database lists still require no model
  // or embedding. Enabled workflow routing is covered by chat_router.test.js.
  t.mock.method(automation, 'settings', async () => ({ enabled: false }));
  t.mock.method(automation.runtime, 'pending', async () => null);
  const catalog = t.mock.method(automation.registry, 'list', async () => { throw new Error('No catalog classification needed'); });
  const selected = { id: 'list-cloud', name: 'Chosen cloud', model: 'chosen-model', apiFormat: 'openai', executionClass: 'remote', supportsToolCalling: true, baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(connector, 'getDefaultDbSource', () => ({ id: 'test-db', dbName: 'Fixture' }));
  const sql = t.mock.method(connector, 'executeSqlQuery', async () => {
    if (!databaseAvailable) throw new Error('Database unavailable');
    return [{ CustomerID: 1, CustomerName: 'Customer fixture' }];
  });
  const embedding = t.mock.method(require('../src/backend/services/qdrant_service'), 'embedTexts', async () => { throw new Error('No embedding needed'); });
  const model = t.mock.method(global, 'fetch', async () => { throw new Error('No model call needed'); });
  const result = await core.chat('ds kh', { providerId: selected.id, knowledgeSearchEnabled: false, permissions: ['sql:read'], session: { id: `fixture-list-chat-${databaseAvailable}`, accountId: 'fixture-account' } });
  assert.equal(result.completionStatus, databaseAvailable ? 'SUCCESS' : 'PARTIAL');
  assert.match(result.replyText, databaseAvailable ? /Customer fixture/ : /Không thể lấy danh sách/);
  assert.equal(sql.mock.callCount(), 1);
  assert.match(sql.mock.calls[0].arguments[0], /\[sales\]\.\[M_Customer\]/);
  assert.doesNotMatch(sql.mock.calls[0].arguments[0], /Password|SELECT.*\*/i);
  assert.equal(embedding.mock.callCount(), 0);
  assert.equal(catalog.mock.callCount(), 0);
  assert.equal(model.mock.callCount(), 0);
});
}

test('ordinary chat uses only the selected model without schema or document embedding', async t => {
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => null);
  const selected = { id: 'chosen', name: 'Chosen cloud', model: 'chosen-model', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', id => id === selected.id ? selected : null);
  t.mock.method(providers, 'getActiveProvider', () => ({ ...selected, id: 'other', model: 'other-model' }));
  const embeddings = t.mock.method(require('../src/backend/services/qdrant_service'), 'embedTexts', async () => { throw new Error('Embedding must not be called'); });
  t.mock.method(require('../src/backend/knowledge_core/services/library_service'), 'getDocuments', () => []);
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
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => null);
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
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => { active = { ...selected, id: 'default-after', model: 'after-model', baseUrl: 'https://after.invalid' }; return null; });
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

for (const flags of [
  { AGENT_CORE_ENABLED: 'true', AI_PROVIDER_GUARDS_ENABLED: 'true' },
  { AGENT_CORE_ENABLED: 'true', AI_PROVIDER_GUARDS_ENABLED: 'false' },
  { AGENT_CORE_ENABLED: 'false', AI_PROVIDER_GUARDS_ENABLED: 'false' }
]) {
  test(`explicit model selection never falls back to another provider (${JSON.stringify(flags)})`, async t => {
    const previous = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
    Object.assign(process.env, flags);
    t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => null);
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
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => null);
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

test('core preserves workflow routing usage alongside verified provider data and progress', async t => {
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async (_, options) => {
    options.onWorkflowUsage({ inputTokens: 100, outputTokens: 20, totalTokens: 120, calls: 2 });
    return null;
  });
  const provider = { id: 'integration', name: 'Fixture cloud', model: 'fixture', apiFormat: 'openai', executionClass: 'remote', supportsToolCalling: true, baseUrl: 'https://test.invalid' };
  t.mock.method(providers, 'getActiveProvider', () => provider);
  t.mock.method(providers, 'getProvidersForExecution', () => [provider]);
  t.mock.method(schema, 'buildSchemaContext', async () => ({ mode: 'data', useTools: true, selectedTables: ['T_Contract'], schemaContext: 'T_Contract(ContractID int, ContractNo varchar)' }));
  t.mock.method(trainingService, 'plan', () => fixture.plan);
  t.mock.method(connector, 'getDefaultDbSource', () => ({ id: 'test-db', dbName: 'Fixture' }));
  const executed = [];
  t.mock.method(connector, 'executeSqlQuery', async (sql, source) => { executed.push({ sql, source }); return fixture.rows; });
  let calls = 0;
  t.mock.method(global, 'fetch', async (_, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.tools?.some(tool => tool.function.name === 'execute_sql_query'));
    const message = ++calls === 1 ? fixture.response : calls === 2
      ? { content: '', tool_calls: [{ id: 'sql', type: 'function', function: { name: 'execute_sql_query', arguments: '{"sql":"SELECT ContractID, ContractNo FROM T_Contract"}' } }] }
      : { content: 'Danh sách hợp đồng.' };
    return { ok: true, json: async () => ({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
  });
  const progress = [];
  const result = await core.chat(fixture.question, { knowledgeSearchEnabled: false, permissions: ['sql:read'], onProgress: event => progress.push(event) });
  assert.equal(result.success, true);
  assert.equal(result.completionStatus, 'SUCCESS');
  assert.equal(executed.length, 1);
  assert.equal(executed[0].source, 'test-db');
  assert.deepEqual(result.executionResult, fixture.rows);
  assert.match(result.replyText, /HD-TEST-001/);
  assert.doesNotMatch(result.replyText, /SELECT|```sql/);
  assert.equal(result.tokenUsage.calls, 5);
  assert.equal(result.tokenUsage.inputTokens, 130);
  assert.equal(result.tokenUsage.outputTokens, 35);
  assert.equal(result.tokenUsage.totalTokens, 165);
  assert.ok(progress.some(event => event.type === 'policy_repair'));
  assert.ok(progress.every(event => !JSON.stringify(event).includes('SELECT')));
  assert.equal(progress.at(-1).status, 'done');
});

test('selected knowledge bypasses workflow/schema and excludes old history even without hits', async t => {
  const flowCalls = t.mock.method(require('../src/backend/automation/chat_router'), 'classifyFlow', async (_, options) => {
    options.routingContext.trace.decisionSource = 'local_tev1';
    return { flow: 'knowledge' };
  });
  const documents = require('../src/backend/knowledge_core/services/retrieval_service');
  const selected = { id: 'knowledge-test', name: 'Knowledge', model: 'test', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid', supportsToolCalling: true };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  const workflow = t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => { throw new Error('No workflow routing'); });
  const schemaCalls = t.mock.method(schema, 'buildSchemaContext', async () => { throw new Error('No schema retrieval'); });
  t.mock.method(require('../src/backend/knowledge_core/services/library_service'), 'getDocuments', () => []);
  let hits = [];
  let expectedSources;
  t.mock.method(documents, 'search', async (_, options) => {
    assert.deepEqual(options.documentIds, expectedSources);
    assert.equal(options.scopeMode, expectedSources.length ? 'selected' : 'all_authorized');
    return { results: hits, mode: 'hybrid' };
  });
  const requests = [];
  t.mock.method(require('../src/backend/agent_core').defaultHarness, 'run', async request => {
    requests.push(request);
    return { replyText: 'Hướng dẫn tải app [1]', toolCalls: [], tokenUsage: { available: false } };
  });
  for (const sourceIds of [['selected-doc'], []]) {
  expectedSources = sourceIds;
  for (const found of [false, true]) {
    hits = found ? [{ payload: { title: 'IPMS', fullText: 'Tải IPMS từ cửa hàng ứng dụng.', chunkIndex: 0 } }] : [];
    const result = await core.chat('tìm trong kho tri thức: cách tải app', { providerId: selected.id, knowledgeSourceIds: sourceIds, history: [{ role: 'user', content: 'OLD_HISTORY_SENTINEL' }], permissions: ['knowledge:read'] });
    assert.equal(result.trace.workflowRouting.decisionSource, sourceIds.length ? 'selected_knowledge' : 'local_tev1');
    const request = requests.at(-1);
    assert.equal(request.context.mode, 'knowledge');
    assert.deepEqual(request.enabledToolNames, []);
    assert.deepEqual(request.context.selectedTables, []);
    assert.equal(request.messages.length, 2);
    assert.doesNotMatch(JSON.stringify(request.messages), /OLD_HISTORY_SENTINEL/);
    assert.match(request.messages[0].content, found ? /IPMS/ : /No matching document passages/);
  }
  }
  assert.equal(workflow.mock.callCount(), 0);
  assert.equal(schemaCalls.mock.callCount(), 0);
  assert.equal(flowCalls.mock.callCount(), 2);
});

test('early workflow replies include flow selection usage exactly once', async t => {
  const selected = { id: 'usage-test', name: 'Usage', model: 'chat-test', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(require('../src/backend/automation/chat_router'), 'classifyFlow', async (_, options) => {
    options.onWorkflowUsage({ inputTokens: 970, outputTokens: 9, totalTokens: 979, calls: 2 });
    return { flow: 'chat' };
  });
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async (_, options) => {
    const usage = { available: true, inputTokens: 179, outputTokens: 1, totalTokens: 180, calls: 1 };
    options.onWorkflowUsage(usage);
    return { success: true, replyText: 'Hello', tokenUsage: usage, trace: { completionStatus: 'SUCCESS' } };
  });
  const result = await core.chat('Hello', { providerId: selected.id });
  assert.deepEqual({ ...result.tokenUsage, byModel: undefined }, { available: true, inputTokens: 1149, outputTokens: 10, totalTokens: 1159, calls: 3, byModel: undefined });
  assert.equal(result.tokenUsage.byModel[0].inputTokens, 1149);
});

test('confident TEV1 greeting returns immediately without workflow or schema work', async t => {
  const selected = { id: 'greeting-test', name: 'Chat', model: 'chat', apiFormat: 'openai', executionClass: 'remote', baseUrl: 'https://chosen.invalid' };
  t.mock.method(providers, 'getProviderForExecution', () => selected);
  t.mock.method(providers, 'getActiveProvider', () => selected);
  t.mock.method(require('../src/backend/automation/chat_router'), 'classifyFlow', async (_, options) => {
    options.onWorkflowUsage({ inputTokens: 300, outputTokens: 1, totalTokens: 301, calls: 1 });
    return { flow: 'chat', quickGreeting: true };
  });
  const workflow = t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', async () => { throw new Error('No second greeting probe'); });
  const schemaCall = t.mock.method(schema, 'buildSchemaContext', async () => { throw new Error('No schema for greeting'); });
  const result = await core.chat('hello', { providerId: selected.id });
  assert.equal(result.success, true);
  assert.equal(result.tokenUsage.calls, 1);
  assert.equal(result.tokenUsage.totalTokens, 301);
  assert.equal(result.trace.workflowRouting.quickReplyKind, 'greeting');
  assert.equal(workflow.mock.callCount(), 0);
  assert.equal(schemaCall.mock.callCount(), 0);
});
