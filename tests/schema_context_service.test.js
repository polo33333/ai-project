'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchemaContext, isStandaloneCalculation } = require('../src/backend/intelligent_core/schema_context_service');
const dictionaryService = require('../src/backend/services/dictionary_service');
const qdrantService = require('../src/backend/services/qdrant_service');
const { withIdentity } = require('../src/backend/services/schema_identity');
const { getDomainAliases, normalizeDomainAliases, normalizeDomainKey } = require('../src/backend/intelligent_core/domain_alias_service');

test('standalone statistics with an explicit number list bypass SQL schema retrieval', () => {
  assert.equal(
    isStandaloneCalculation('Tính min, max, trung bình của dãy số: 120, 450, 230, 890, 340, 670'),
    true
  );
});

test('schema context routes the reported statistics prompt to general utility tools', async () => {
  const context = await buildSchemaContext(
    'Tính min, max, trung bình của dãy số: 120, 450, 230, 890, 340, 670',
    { dbName: 'IPMS' }
  );
  assert.equal(context.mode, 'general');
  assert.deepEqual(context.selectedTables, []);
});

test('database statistics still use schema retrieval', () => {
  assert.equal(isStandaloneCalculation('Tính min, max cột doanh thu trong bảng hóa đơn'), false);
  assert.equal(
    isStandaloneCalculation('Tính trung bình 120, 450 cho cột doanh thu', { hasSchemaMatch: true }),
    false
  );
});

test('long arithmetic expressions bypass SQL schema retrieval', () => {
  assert.equal(isStandaloneCalculation('Hãy tính giúp tôi (120 + 450 + 230) / 3'), true);
});

test('Vietnamese natural-language contract requests select the configured contract domain', async () => {
  for (const question of ['ds hợp đồng', 'bảng hợp đồng hiện tại có dữ liệu gì']) {
    const context = await buildSchemaContext(question, { dbName: 'IPMS' });
    assert.equal(context.mode, 'data');
    assert.equal(context.selectedTables[0], 'T_Contract');
    assert.match(context.schemaContext, /Business domain: contract/);
  }
});

test('business domains accept Vietnamese natural-language labels', () => {
  assert.equal(dictionaryService.normalizeDomain('Hợp đồng dịch vụ'), 'hop_dong_dich_vu');
  assert.equal(dictionaryService.normalizeDomain('Điện bán ra'), 'dien_ban_ra');
});

test('domain aliases are loaded from the editable data file', () => {
  const aliases = getDomainAliases();
  assert.ok(aliases.contract.includes('hop dong'));
});

test('invalid domain alias entries are safely normalized', () => {
  assert.deepEqual(normalizeDomainAliases({ contract: ['hop dong', '', 'hop dong'], invalid: 'text' }), {
    contract: ['hop dong'],
    invalid: []
  });
});

test('Vietnamese domain keys are normalized for persistent configuration', () => {
  assert.equal(normalizeDomainKey('Hợp đồng dịch vụ'), 'hop_dong_dich_vu');
});

test('described lookup fields are automatically enriched for single-table queries', async t => {
  const previousTables = dictionaryService.tablesStore;
  const previousRelationships = dictionaryService.tableRelationships;
  const previousGlossary = dictionaryService.businessGlossary;
  const previousSearch = qdrantService.searchSchema;
  const previousFlag = process.env.SQL_JOIN_PLANNER_ENABLED;
  t.after(() => {
    dictionaryService.tablesStore = previousTables;
    dictionaryService.tableRelationships = previousRelationships;
    dictionaryService.businessGlossary = previousGlossary;
    qdrantService.searchSchema = previousSearch;
    if (previousFlag === undefined) delete process.env.SQL_JOIN_PLANNER_ENABLED;
    else process.env.SQL_JOIN_PLANNER_ENABLED = previousFlag;
  });
  const employee = withIdentity({ dbSourceId: 'source', dbName: 'IPMS', schemaName: 'dbo', tableName: 'M_Employee',
    isActive: true, tableDescription: 'Danh sách nhân viên', columns: [{ columnName: 'EmployeeName', dataType: 'NVARCHAR' }, { columnName: 'GenderID', dataType: 'INT', description: 'Giới tính của nhân viên' }] });
  const constant = withIdentity({ dbSourceId: 'source', dbName: 'IPMS', schemaName: 'dbo', tableName: 'M_Constant',
    isActive: true, tableDescription: 'Danh mục hằng số', columns: [{ columnName: 'ConstantID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'ConstantName', dataType: 'NVARCHAR' }] });
  dictionaryService.tablesStore = [employee, constant];
  dictionaryService.businessGlossary = [{ term: 'nv', fullMeaning: 'nhân viên', category: 'Nhân sự' }];
  dictionaryService.tableRelationships = [{ id: 'gender', sourceTableId: employee.tableId, targetTableId: constant.tableId,
    sourceTable: employee.tableName, targetTable: constant.tableName, sourceColumn: 'GenderID', targetColumn: 'ConstantID',
    columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }], cardinality: 'many-to-one', businessRole: 'Giới tính của nhân viên', status: 'verified', isActive: true, revision: 1 }];
  qdrantService.searchSchema = async () => [];
  process.env.SQL_JOIN_PLANNER_ENABLED = 'true';

  const listContext = await buildSchemaContext('ds 5 nv', { dbName: 'IPMS', dbSourceId: 'source' });
  assert.deepEqual(listContext.selectedTables, ['M_Employee', 'M_Constant']);
  assert.equal(listContext.joinPlan.outcome, 'ready');
  assert.equal(listContext.joinPlan.purpose, 'enrichment');
  assert.match(listContext.schemaContext, /Auto-enrichment requirement/);

  const genderContext = await buildSchemaContext('giới tính nv có tên duy là gì', { dbName: 'IPMS', dbSourceId: 'source' });
  assert.deepEqual(genderContext.selectedTables, ['M_Employee', 'M_Constant']);
  assert.equal(genderContext.joinPlan.outcome, 'ready');
  assert.equal(genderContext.joinPlan.edges.length, 1);
});
