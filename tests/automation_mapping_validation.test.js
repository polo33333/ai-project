'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBinding, validateResultMapping } = require('../src/backend/automation/sql');
const binding = { dbSourceId: 'test', sql: 'SELECT e.address AS Address FROM dbo.Records e', tables: ['dbo.Records'], parameters: {},
  resultMapping: [{ key: 'Address', tableId: 'records', columnName: 'address', relationId: null }] };
test('mapping rejects blank source links and a key different from the SQL alias', () => {
  assert.doesNotThrow(() => validateBinding(binding));
  assert.throws(() => validateBinding({ ...binding, resultMapping: [{ ...binding.resultMapping[0], tableId: '' }] }), /Address/);
  assert.throws(() => validateBinding({ ...binding, resultMapping: [{ ...binding.resultMapping[0], key: 'Other' }] }), /Other/);
});
test('mapping preflight checks current exposed columns without executing SQL', () => {
  const dictionary = { tablesStore: [{ tableId: 'records', dbSourceId: 'test', isActive: true, columns: [{ columnName: 'address', isVisible: true }] }], tableRelationships: [] };
  assert.doesNotThrow(() => validateResultMapping(binding, dictionary));
  dictionary.tablesStore[0].columns[0].isVisible = false;
  assert.throws(() => validateResultMapping(binding, dictionary), /Address/);
});
