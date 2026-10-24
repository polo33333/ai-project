'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dictionary = require('../src/backend/services/dictionary_service');
const aliases = require('../src/backend/intelligent_core/domain_alias_service');
const qdrant = require('../src/backend/services/qdrant_service');
const { buildSchemaContext } = require('../src/backend/intelligent_core/schema_context_service');
const { withIdentity } = require('../src/backend/services/schema_identity');

function setup(t, tables) {
  const identified = tables.map(table => withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', isActive: true, ...table }));
  t.mock.method(dictionary, 'getGroupedTables', () => identified);
  t.mock.method(dictionary, 'getGlossary', () => []);
  t.mock.method(dictionary, 'getTableRelationships', () => []);
  t.mock.method(aliases, 'getDomainAliases', () => ({}));
  t.mock.method(qdrant, 'searchSchema', async () => ({ results: [], status: 'ok' }));
}
const select = query => buildSchemaContext(query, { dbSourceId: 'src', forceRetrieval: true });

test('the table that is the entity outranks a wide table whose columns merely mention it', async t => {
  setup(t, [
    { tableName: 'M_Customer', tableDescription: 'Khách hàng.', columns: [
      { columnName: 'SurveyNote', dataType: 'nvarchar', description: 'Ghi chú khảo sát khách hàng' },
      { columnName: 'SurveyDate', dataType: 'date', description: 'Ngày khảo sát khách hàng gần nhất' }] },
    { tableName: 'BS_Survey', tableDescription: 'Khảo sát khách hàng.', semanticModel: { entity: 'Khảo sát khách hàng' },
      columns: [{ columnName: 'SurveyID', dataType: 'int' }] }
  ]);
  assert.equal((await select('Lịch khảo sát khách hàng tuần này')).selectedTables[0], 'BS_Survey');
});

test('Vietnamese column labels take part in ranking', async t => {
  setup(t, [
    { tableName: 'T_A', tableDescription: 'Chứng từ A.', columns: [{ columnName: 'X1', dataType: 'int' }] },
    { tableName: 'T_B', tableDescription: 'Chứng từ B.', columns: [{ columnName: 'Qty120', dataType: 'int', displayName: 'Số thùng rác 120 lít' }] }
  ]);
  assert.equal((await select('Tổng số thùng rác 120 lít')).selectedTables[0], 'T_B');
});

test('generated column descriptions carry no ranking signal', async t => {
  setup(t, [{ tableName: 'T_Records', tableDescription: 'Bản ghi.', columns: [
    { columnName: 'Code', dataType: 'varchar', description: 'Cột Code trong bảng SQL Server T_Records' }] }]);
  assert.equal((await select('server')).needsModelSelection, true);
});

test('generic words such as "thông tin" do not pull a table that starts its description with them', async t => {
  setup(t, [
    { tableName: 'M_Company', tableDescription: 'Thông tin đơn vị vận hành.', columns: [{ columnName: 'CompanyID', dataType: 'int' }] },
    { tableName: 'M_Customer', tableDescription: 'Khách hàng.', semanticModel: { entity: 'Khách hàng' }, columns: [{ columnName: 'CustomerID', dataType: 'int' }] }
  ]);
  assert.equal((await select('Thông tin khách hàng KA01')).selectedTables[0], 'M_Customer');
});
