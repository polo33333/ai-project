'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestStores } = require('../src/backend/storage/request_stores');

test('relationship reads load both relationships and their dictionary identities', () => {
  const files = requestStores({ method: 'GET', url: '/api/dictionary/relationships' });
  assert.ok(files.includes('table_relationships.json'));
  assert.ok(files.includes('dictionary.json'));
});

test('common saves load only audited dependencies and fresh authentication', () => {
  for (const url of ['/api/dictionary/save-table-configuration','/api/ai-providers/update','/api/persona']) {
    const files=requestStores({method:'POST',url});
    for (const file of ['accounts.json','sessions.json','account_roles.json','logs.json']) assert.ok(files.includes(file));
    assert.ok(!files.includes('chat_history.json'));
    assert.ok(!files.includes('conversation_memory.json'));
  }
  assert.equal(requestStores({method:'POST',url:'/api/tools/execute'}),undefined);
});

test('workflow catalog reads avoid unrelated application stores and retain fresh authentication', () => {
  for (const url of ['/api/workflow-plugins', '/api/question-templates']) {
    assert.deepEqual(requestStores({ method: 'GET', url }), ['accounts.json', 'sessions.json', 'account_roles.json']);
    assert.equal(requestStores({ method: 'POST', url }), undefined, 'Mutations keep the full scope');
  }
  const files = requestStores({ method: 'GET', url: '/api/automation-runs?summary=1' });
  assert.ok(files.includes('dictionary.json'));
  assert.ok(files.includes('table_relationships.json'));
  assert.ok(!files.includes('chat_history.json'));
});
test('individual workflow polling is scoped and never falls back to full chat history', () => {
  for (const id of ['auto_test', 'auto_f25126114f25131574eacde2af6e457acca8ccd3']) {
    assert.deepEqual(requestStores({ method: 'GET', url: `/api/automation-runs/${id}?refresh=1` }),
      ['accounts.json','sessions.json','account_roles.json','dictionary.json','table_relationships.json','db_sources.json','library.json']);
    for (const suffix of ['events?after=1', 'artifacts/report-id'])
      assert.deepEqual(requestStores({ method: 'GET', url: `/api/automation-runs/${id}/${suffix}` }), ['accounts.json','sessions.json','account_roles.json','db_sources.json','library.json']);
    assert.equal(requestStores({ method: 'POST', url: `/api/automation-runs/${id}/inputs` }), undefined);
  }
});
