'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tableIdentity, columnIdentity, withIdentity, sameTable } = require('../src/backend/services/schema_identity');

test('schema identity separates equal table names across source, database, and schema', () => {
  const a = withIdentity({ dbSourceId: 'source-a', dbName: 'Main', schemaName: 'sales', tableName: 'Orders', columns: [{ columnName: 'Id' }] });
  const b = withIdentity({ dbSourceId: 'source-b', dbName: 'Main', schemaName: 'sales', tableName: 'Orders', columns: [{ columnName: 'Id' }] });
  const c = withIdentity({ dbSourceId: 'source-a', dbName: 'Main', schemaName: 'archive', tableName: 'Orders', columns: [{ columnName: 'Id' }] });
  assert.notEqual(tableIdentity(a), tableIdentity(b));
  assert.notEqual(tableIdentity(a), tableIdentity(c));
  assert.equal(sameTable(a, { ...a }), true);
  assert.equal(a.columns[0].columnId, columnIdentity(a, { columnName: 'Id' }));
});

test('legacy tables receive deterministic fallback identity', () => {
  const table = withIdentity({ dbName: 'Legacy', tableName: 'Customers', columns: [] });
  assert.equal(table.schemaName, 'dbo');
  assert.equal(table.tableId, 'legacy::legacy::dbo::customers');
});
