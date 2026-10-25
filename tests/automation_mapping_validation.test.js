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
test('a relation verified after publishing does not break a raw column, except while authoring', () => {
  const dictionary = { tablesStore: [
    { tableId: 'records', dbSourceId: 'test', isActive: true, columns: [{ columnName: 'address', isVisible: true }] },
    { tableId: 'places', dbSourceId: 'test', isActive: true, columns: [{ columnName: 'id', isVisible: true }, { columnName: 'name', isVisible: true }] }],
  tableRelationships: [{ id: 'rel', sourceTableId: 'records', targetTableId: 'places', isActive: true, status: 'verified', cardinality: 'many-to-one',
    displayColumn: 'name', columnPairs: [{ sourceColumn: 'address', targetColumn: 'id' }] }] };
  assert.doesNotThrow(() => validateResultMapping(binding, dictionary));
  assert.throws(() => validateResultMapping(binding, dictionary, { strict: true }), /Address/);
  const related = { ...binding, resultMapping: [{ ...binding.resultMapping[0], relationId: 'gone' }] };
  assert.throws(() => validateResultMapping(related, dictionary), /Address/);
});
