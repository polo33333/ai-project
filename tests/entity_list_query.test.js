'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const expand = require('../src/backend/utils/entity_list_query');
const { createRequestPlan } = require('../src/backend/training/request_planner');
const dictionary = require('../src/backend/services/dictionary_service');

test('abbreviated lists select the configured glossary domain despite unrelated retrieval order', t => {
  t.mock.method(dictionary, 'getGlossary', () => [
    { term: 'KH', fullMeaning: 'Khách hàng' }, { term: 'NV', fullMeaning: 'Nhân viên' },
    { term: 'HĐ', fullMeaning: 'Hợp đồng' }
  ]);
  const dictionaryTables = ['electricity', 'employee', 'customer', 'contract'].map(domain => ({
    domain, tableName: domain, columns: [{ columnName: 'Name', dataType: 'nvarchar' }]
  }));
  const domainAliases = { employee: ['nhan vien'], customer: ['khach hang'], contract: ['hop dong'] };
  for (const [question, expected] of [['ds hđ', 'contract'], ['ds kh', 'customer'], ['ds nv', 'employee'],
    ['ds kh', 'customer'], ['ds kh', 'customer'], ['ds hđ', 'contract']]) {
    const plan = createRequestPlan({ question, dictionaryTables, domainAliases,
      selectedTables: dictionaryTables.map(table => table.tableName) });
    assert.equal(plan.table, expected);
    assert.equal(plan.unfilteredList, true);
  }
});

test('edited, disabled and conflicting glossary meanings are respected', () => {
  assert.equal(expand('ds hđ', [{ term: 'HD', fullMeaning: 'Hóa đơn GTGT' }]), 'danh sach hoa don gtgt');
  assert.equal(expand('ds hđ', [{ term: 'HD', fullMeaning: 'Hợp đồng', isActive: false }]), 'ds hđ');
  const entries = [{ term: 'HD', fullMeaning: 'Hóa đơn GTGT' },
    { term: 'HĐ', fullMeaning: 'Hợp đồng' }];
  assert.equal(expand('ds hđ', entries), 'danh sach hop dong');
  assert.equal(expand('ds hd', entries), 'danh sach hoa don gtgt');
  assert.equal(expand('ds hđ', [{ term: 'HĐ', fullMeaning: 'Hợp đồng' },
    { term: 'HĐ', fullMeaning: 'Hóa đơn' }]), 'ds hđ');
});

test('expansion preserves record identifiers, filters and ambiguous bare abbreviations', () => {
  for (const text of ['kh', 'nv ma NV004', 'ds kh co ma KH001', 'SELECT hd FROM T', 'ds hoa don']) {
    assert.equal(expand(text), text);
  }
});
test('original accented abbreviation resolves its configured entity before model search keywords', t => {
  t.mock.method(dictionary, 'getGlossary', () => [{ term: 'HD', fullMeaning: 'Hóa đơn GTGT' }, { term: 'HĐ', fullMeaning: 'Hợp đồng' }]);
  t.mock.method(dictionary, 'getGroupedTables', () => [
    { tableName: 'Organizations', dbSourceId: 's', isActive: true, columns: [], semanticModel: { entity: 'Đơn vị quản lý' } },
    { tableName: 'Agreements', dbSourceId: 's', isActive: true, columns: [], semanticModel: { entity: 'Hợp đồng', aliases: ['hợp đồng'] } }
  ]);
  const service = require('../src/backend/assistant/schema_context_service');
  assert.equal(service.explicitListTable('ds hđ', { dbSourceId: 's' }).tableName, 'Agreements');
  assert.equal(service.explicitListTable('ds hd', { dbSourceId: 's' }), null);
  assert.equal(service.explicitListTable('ds hđ', { dbSourceId: 'other' }), null);
});
test('governed schema search anchors the original list even when model keywords and prior root are unrelated', async t => {
  const governance = require('../src/backend/governance/context'), connector = require('../src/backend/services/sql_connector');
  const schema = require('../src/backend/assistant/schema_context_service');
  const aliases = require('../src/backend/assistant/domain_alias_service');
  t.mock.method(dictionary, 'getGlossary', () => [{ term: 'HD', fullMeaning: 'Hóa đơn GTGT' }, { term: 'HĐ', fullMeaning: 'Hợp đồng' }]);
  t.mock.method(aliases, 'getDomainAliases', () => ({ contract: ['hop dong'] }));
  t.mock.method(dictionary, 'getGroupedTables', () => [
    { tableName: 'Organizations', dbSourceId: 'metadata-fixture', isActive: true, columns: [{ columnName: 'ID' }] },
    { tableName: 'Agreements', domain: 'contract', semanticModel: { entity: 'Hợp đồng', aliases: ['hợp đồng'] }, dbSourceId: 'metadata-fixture', isActive: true, columns: [{ columnName: 'ID' }] }
  ]);
  let root, query;
  t.mock.method(schema, 'buildSchemaContext', async value => { query = value; return { mode: 'data', selectedTables: ['Organizations'], schemaContext: '' }; });
  t.mock.method(schema, 'refineSchemaContext', (value, names) => { root = names[0]; return { selectedTables: names, schemaContext: '' }; });
  const sources = connector.dbSources, source = { id: 'metadata-fixture', isActive: true };
  sources.push(source); t.after(() => sources.splice(sources.indexOf(source), 1));
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:metadata-test', role: 'admin' });
    const result = await require('../src/backend/assistant/tool_registry')._searchSchema({ query: 'management organizations', request: { operation: 'list', attributes: [], presentation: 'table' } },
      { governedController: true, userMessage: 'ds hđ', dbSourceId: source.id, permissions: ['admin'], requestPlan: { table: 'Organizations' } });
    assert.equal(query, 'danh sach hop dong');
    assert.equal(root, 'Agreements');
    assert.equal(result.result.requestedPrimaryTable, 'Agreements');
    assert.deepEqual(result.result.selectedTables, ['Agreements']);
  });
});
