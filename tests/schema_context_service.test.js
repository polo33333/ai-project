'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchemaContext, isStandaloneCalculation } = require('../src/backend/intelligent_core/schema_context_service');
const dictionaryService = require('../src/backend/services/dictionary_service');
const qdrantService = require('../src/backend/services/qdrant_service');
const { withIdentity } = require('../src/backend/services/schema_identity');
const { getDomainAliases, normalizeDomainAliases, normalizeDomainKey } = require('../src/backend/intelligent_core/domain_alias_service');
const { validateSqlAgainstJoinPlan } = require('../src/backend/services/sql_join_validator');

test('standalone statistics with an explicit number list bypass SQL schema retrieval', () => {
  assert.equal(
    isStandaloneCalculation('Tính min, max, trung bình của dãy số: 120, 450, 230, 890, 340, 670'),
    true
  );
});

test('semantic retrieval retains a strong table despite an unrelated lexical match', async t => {
  const oldTables = dictionaryService.tablesStore;
  const oldRelationships = dictionaryService.tableRelationships;
  const oldSearch = qdrantService.searchSchema;
  t.after(() => {
    dictionaryService.tablesStore = oldTables;
    dictionaryService.tableRelationships = oldRelationships;
    qdrantService.searchSchema = oldSearch;
  });
  const semantic = withIdentity({ dbSourceId: 'source', dbName: 'ERP', schemaName: 'dbo', tableName: 'T_Invoice', isActive: true,
    tableDescription: 'Invoices', columns: [{ columnName: 'InvoiceID', dataType: 'INT' }] });
  const lexical = withIdentity({ dbSourceId: 'source', dbName: 'ERP', schemaName: 'dbo', tableName: 'T_Status', isActive: true,
    tableDescription: 'status', columns: [{ columnName: 'StatusID', dataType: 'INT' }] });
  dictionaryService.tablesStore = [semantic, lexical];
  dictionaryService.tableRelationships = [];
  qdrantService.searchSchema = async () => [{ score: 0.9, payload: { tableId: semantic.tableId, tableName: semantic.tableName } }];
  const context = await buildSchemaContext('status of invioce', { dbSourceId: 'source' });
  assert.equal(context.mode, 'data');
  assert.ok(context.selectedTableIds.includes(semantic.tableId));
  assert.match(context.schemaContext, /Table T_Invoice/);
  qdrantService.searchSchema = async () => [{ score: 0.1, payload: { tableId: semantic.tableId } }];
  const weak = await buildSchemaContext('status of invioce', { dbSourceId: 'source' });
  assert.deepEqual(weak.selectedTableIds, [lexical.tableId]);
});

test('schema retrieval distinguishes an empty result from a failed search', async t => {
  const oldSearch = qdrantService.searchSchema;
  t.after(() => { qdrantService.searchSchema = oldSearch; });
  qdrantService.searchSchema = async () => ({ results: [], status: 'ok', errorCode: null });
  const empty = await buildSchemaContext('bảng hợp đồng', { dbName: 'IPMS' });
  assert.equal(empty.retrieval.semanticSearch.status, 'ok');
  qdrantService.searchSchema = async () => ({ results: [], status: 'degraded', errorCode: 'SCHEMA_SEARCH_FAILED' });
  const degraded = await buildSchemaContext('bảng hợp đồng', { dbName: 'IPMS' });
  assert.equal(degraded.retrieval.semanticSearch.status, 'degraded');
  assert.equal(degraded.retrieval.vectorMatches, 0);
});

test('Qdrant detailed search reports failures while array API remains compatible', async t => {
  const oldEnsure = qdrantService.ensureCollection;
  const oldEmbed = qdrantService.embedTexts;
  const oldRequest = qdrantService.request;
  t.after(() => {
    qdrantService.ensureCollection = oldEnsure;
    qdrantService.embedTexts = oldEmbed;
    qdrantService.request = oldRequest;
  });
  qdrantService.ensureCollection = async () => {};
  qdrantService.embedTexts = async () => [[0.1]];
  qdrantService.request = async () => ({ result: [] });
  assert.deepEqual(await qdrantService.searchSchema('invoice'), []);
  assert.equal((await qdrantService.searchSchema('invoice', 5, { detailed: true })).status, 'ok');
  qdrantService.request = async () => { throw new Error('HTTP unavailable'); };
  const failed = await qdrantService.searchSchema('invoice', 5, { detailed: true });
  assert.deepEqual(failed, { results: [], status: 'degraded', errorCode: 'SCHEMA_SEARCH_FAILED' });
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

test('general multi-table context carries root grain into fan-out validation', async t => {
  const previousTables = dictionaryService.tablesStore;
  const previousRelationships = dictionaryService.tableRelationships;
  const previousSearch = qdrantService.searchSchema;
  const previousFlag = process.env.SQL_JOIN_PLANNER_ENABLED;
  t.after(() => {
    dictionaryService.tablesStore = previousTables;
    dictionaryService.tableRelationships = previousRelationships;
    qdrantService.searchSchema = previousSearch;
    if (previousFlag === undefined) delete process.env.SQL_JOIN_PLANNER_ENABLED;
    else process.env.SQL_JOIN_PLANNER_ENABLED = previousFlag;
  });
  const contract = withIdentity({ dbSourceId: 'source', dbName: 'ERP', schemaName: 'dbo', tableName: 'T_Contract',
    isActive: true, tableDescription: 'contract detail listing', columns: [{ columnName: 'ContractID', dataType: 'INT', isPrimaryKey: true }] });
  const detail = withIdentity({ dbSourceId: 'source', dbName: 'ERP', schemaName: 'dbo', tableName: 'T_ContractDetail',
    isActive: true, tableDescription: 'contract detail listing', columns: [{ columnName: 'DetailID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'ContractID', dataType: 'INT' }] });
  dictionaryService.tablesStore = [contract, detail];
  dictionaryService.tableRelationships = [{ id: 'contract_details', sourceTableId: contract.tableId, targetTableId: detail.tableId,
    sourceTable: contract.tableName, targetTable: detail.tableName, columnPairs: [{ sourceColumn: 'ContractID', targetColumn: 'ContractID' }],
    cardinality: 'one-to-many', status: 'verified', isActive: true, revision: 1 }];
  qdrantService.searchSchema = async () => [];
  process.env.SQL_JOIN_PLANNER_ENABLED = 'true';

  const context = await buildSchemaContext('contract detail listing', { dbName: 'ERP', dbSourceId: 'source' });
  assert.equal(context.joinPlan.outcome, 'ready');
  assert.equal(context.joinPlan.rootTableId, contract.tableId);
  assert.equal(context.joinPlan.expectedGrain, 'root');
  const validation = validateSqlAgainstJoinPlan(
    'SELECT p.ContractID FROM T_Contract p JOIN T_ContractDetail d ON p.ContractID = d.ContractID', context.joinPlan);
  assert.equal(validation.valid, false);
  assert.equal(validation.code, 'JOIN_GRAIN_UNSAFE');
});
