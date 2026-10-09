'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestStores } = require('../src/backend/storage/request_stores');

test('relationship reads load both relationships and their dictionary identities', () => {
  const files = requestStores({ method: 'GET', url: '/api/dictionary/relationships' });
  assert.ok(files.includes('table_relationships.json'));
  assert.ok(files.includes('dictionary.json'));
});

test('workflow catalog reads avoid unrelated application stores and retain fresh authentication', () => {
  for (const url of ['/api/workflow-plugins', '/api/question-templates']) {
    assert.deepEqual(requestStores({ method: 'GET', url }), ['accounts.json', 'sessions.json']);
    assert.equal(requestStores({ method: 'POST', url }), undefined, 'Mutations keep the full scope');
  }
  const files = requestStores({ method: 'GET', url: '/api/automation-runs?summary=1' });
  assert.ok(files.includes('dictionary.json'));
  assert.ok(files.includes('table_relationships.json'));
  assert.ok(!files.includes('chat_history.json'));
});
