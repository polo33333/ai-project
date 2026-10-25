'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
test('dictionary workspace coalesces tab loads and keeps existing data on failure, then retries', async () => {
  const source = fs.readFileSync('src/frontend/admin-client/js/modules/dictionary.js', 'utf8');
  let resolve, requests = 0;
  const context = { window: { groupedTablesData: ['previous'], businessDomainsData: {}, tableRelationshipsData: [] },
    console: { error() {} }, renderDictionaryDomainOptions() {}, renderDataDictionary() {},
    fetch() { requests++; return new Promise(done => { resolve = done; }); } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let dictionaryWorkspaceRequest'), source.indexOf('function renderDictionaryDomainOptions')), context);
  const first = context.fetchDataDictionary(), second = context.fetchDataDictionary();
  assert.equal(first, second); assert.equal(requests, 1);
  resolve({ ok: false, status: 503 });
  assert.equal(await first, false);
  assert.deepEqual(context.window.groupedTablesData, ['previous']);
  const retry = context.fetchDataDictionary(); assert.equal(requests, 2);
  resolve({ ok: true, json: async () => ({ tables: [], domains: {}, relationships: [] }) });
  await retry; assert.deepEqual(context.window.groupedTablesData, []);
});
test('workspace snapshot is restricted to auth and dictionary dependencies', () => {
  assert.deepEqual(require('../src/backend/storage/request_stores').requestStores({ method: 'GET', url: '/api/dictionary/workspace' }),
    ['accounts.json','sessions.json','account_roles.json','dictionary.json','domain_aliases.json','table_relationships.json','db_sources.json']);
});

test('forced reload on source switch ignores an older in-flight workspace response', async () => {
  const source = fs.readFileSync('src/frontend/admin-client/js/modules/dictionary.js', 'utf8');
  const pending = [];
  const context = { window: { paginationState: { dictionary: { currentPage: 3 } }, selectedDictionaryTableId: 'old', dictionaryGraphSelection: 'Old' },
    console: { error() {} }, renderDictionaryQuality() {}, renderDictionaryDomainOptions() {}, renderDataDictionary() {},
    fetch() { return new Promise(resolve => pending.push(resolve)); } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let dictionaryWorkspaceRequest'), source.indexOf('function renderDictionaryDomainOptions')), context);
  context.renderDictionaryQuality = () => {};
  const first = context.fetchDataDictionary();
  const newer = context.fetchDataDictionary({ force: true });
  const snapshot = id => ({ ok: true, json: async () => ({ source: { id, dbName: id }, tables: [{ tableName: id }], relationships: [], domains: {} }) });
  pending[1](snapshot('new'));
  await newer;
  pending[0](snapshot('old'));
  await first;
  assert.equal(context.window.dictionaryWorkspaceSource.id, 'new');
  assert.equal(context.window.groupedTablesData[0].tableName, 'new');
  assert.equal(context.window.selectedDictionaryTableId, null);
  assert.equal(context.window.dictionaryGraphSelection, null);
  assert.equal(context.window.paginationState.dictionary.currentPage, 1);
});
