'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DictionaryService } = require('../src/backend/services/dictionary_service');

test('workspace follows the default source and excludes same-named tables and cross-source relationships', () => {
  const service = Object.create(DictionaryService.prototype);
  const sources = [{ id: 'one', dbName: 'ERP' }, { id: 'two', dbName: 'ERP_Copy' }];
  service.getGroupedTables = () => [
    { tableId: 'one:A', tableName: 'A', dbSourceId: 'one' }, { tableId: 'one:B', tableName: 'B', dbSourceId: 'one' },
    { tableId: 'two:A', tableName: 'A', dbSourceId: 'two' }, { tableId: 'two:B', tableName: 'B', dbSourceId: 'two' }
  ];
  service.getTableRelationships = () => [
    { id: 'first', sourceTableId: 'one:A', targetTableId: 'one:B' },
    { id: 'second', sourceTableId: 'two:A', targetTableId: 'two:B' },
    { id: 'cross', sourceTableId: 'one:A', targetTableId: 'two:B' },
    { id: 'ambiguous', sourceTable: 'A', targetTable: 'B' }
  ];
  for (let i = 0; i < sources.length; i++) {
    const result = service.getWorkspaceForSource(sources[i], sources);
    assert.equal(result.tables.length, 2);
    assert.ok(result.tables.every(table => table.dbSourceId === sources[i].id));
    assert.deepEqual(result.relationships.map(relation => relation.id), [i ? 'second' : 'first']);
    assert.equal(result.source.id, sources[i].id);
  }
  assert.equal(service.getWorkspaceForSource({ id: 'empty', dbName: 'Empty' }, sources).tables.length, 0);
  assert.deepEqual(service.getWorkspaceForSource(null), { source: null, tables: [], relationships: [] });
});

test('legacy schema is shown only when its database identifies a single source', () => {
  const service = Object.create(DictionaryService.prototype);
  service.getGroupedTables = () => [{ tableId: 'legacy:A', tableName: 'A', dbName: 'ERP' }];
  service.getTableRelationships = () => [];
  const source = { id: 'one', dbName: 'ERP' };
  assert.equal(service.getWorkspaceForSource(source, [source]).tables.length, 1);
  assert.equal(service.getWorkspaceForSource(source, [source, { id: 'two', dbName: 'ERP' }]).tables.length, 0);
});
