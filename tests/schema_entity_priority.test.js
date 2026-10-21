'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dictionary = require('../src/backend/services/dictionary_service');
const aliases = require('../src/backend/intelligent_core/domain_alias_service');
const qdrant = require('../src/backend/services/qdrant_service');
const { explicitListTable, buildSchemaContext } = require('../src/backend/intelligent_core/schema_context_service');
const { withIdentity } = require('../src/backend/services/schema_identity');

function setup(t) {
  const tables = [
    { tableName: 'M_Company', domain: 'organization', semanticModel: { entity: 'Đơn vị vận hành', aliases: ['Ban quản lý'] } },
    { tableName: 'M_Customer', domain: 'customer', semanticModel: { entity: 'Khách hàng', aliases: ['Doanh nghiệp'] } }
  ].map(table => withIdentity({ ...table, dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', isActive: true,
    columns: [{ columnName: 'Id', dataType: 'int' }] }));
  t.mock.method(dictionary, 'getGroupedTables', () => tables);
  t.mock.method(dictionary, 'getGlossary', () => []);
  t.mock.method(dictionary, 'getTableRelationships', () => []);
  t.mock.method(aliases, 'getDomainAliases', () => ({ organization: ['khách hàng', 'tổ chức'], customer: ['doanh nghiệp'] }));
  t.mock.method(qdrant, 'searchSchema', async () => ({ results: [], status: 'ok' }));
  return tables;
}

test('table-specific entity wins over conflicting domain keywords in both selection paths', async t => {
  setup(t);
  const query = 'Danh sách khách hàng';
  assert.equal(explicitListTable(query, { dbSourceId: 'src' }).tableName, 'M_Customer');
  const context = await buildSchemaContext(query, { dbSourceId: 'src', forceRetrieval: true });
  assert.equal(context.selectedTables[0], 'M_Customer');
});

test('domain alone never identifies a table, even if only one table uses it', t => {
  setup(t);
  assert.equal(explicitListTable('Danh sách tổ chức', { dbSourceId: 'src' }), null);
  assert.equal(explicitListTable('Danh sách organization', { dbSourceId: 'src' }), null);
});

test('duplicate entity aliases stay ambiguous and source scope is respected', t => {
  const tables = setup(t);
  tables[0].semanticModel.aliases.push('Doanh nghiệp');
  assert.equal(explicitListTable('Danh sách doanh nghiệp', { dbSourceId: 'src' }), null);
  assert.equal(explicitListTable('Danh sách khách hàng', { dbSourceId: 'other' }), null);
  assert.equal(explicitListTable('Danh sách dbo.M_Customer', { dbSourceId: 'src' }).tableName, 'M_Customer');
});
