'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/backend/intelligent_core/core');
const providers = require('../src/backend/services/ai_provider_manager');
const schema = require('../src/backend/intelligent_core/schema_context_service');
const connector = require('../src/backend/services/sql_connector');
const { trainingService } = require('../src/backend/training_core');
const fixture = require('./fixtures/provider_raw_contract_chat.json');

test('core integration returns only verified final data and safe progress after raw provider SQL', async t => {
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
  assert.equal(result.tokenUsage.calls, 3);
  assert.ok(progress.some(event => event.type === 'policy_repair'));
  assert.ok(progress.every(event => !JSON.stringify(event).includes('SELECT')));
  assert.equal(progress.at(-1).status, 'done');
});
