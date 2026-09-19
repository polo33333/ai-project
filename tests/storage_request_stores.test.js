'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestStores } = require('../src/backend/storage/request_stores');

test('relationship reads load both relationships and their dictionary identities', () => {
  const files = requestStores({ method: 'GET', url: '/api/dictionary/relationships' });
  assert.ok(files.includes('table_relationships.json'));
  assert.ok(files.includes('dictionary.json'));
});
