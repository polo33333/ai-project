'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('mutation responses cannot add another database source back into the selected workspace', () => {
  const context = vm.createContext({ window: {}, console, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync('src/frontend/js/modules/dictionary.js', 'utf8'), context);
  Object.assign(context.window, { dictionaryWorkspaceSource: { id: 'one' }, groupedTablesData: [
    { tableId: 'one:A', tableName: 'A', dbSourceId: 'one' }, { tableId: 'one:B', tableName: 'B', dbSourceId: 'one' }
  ] });
  context.tables = [...context.window.groupedTablesData, { tableId: 'two:A', tableName: 'A', dbSourceId: 'two' }];
  context.relations = [{ sourceTableId: 'one:A', targetTableId: 'one:B' }, { sourceTableId: 'two:A', targetTableId: 'one:B' }];
  assert.equal(vm.runInContext('scopeDictionaryMutationTables(tables).length', context), 2);
  assert.equal(vm.runInContext('scopeDictionaryMutationRelationships(relations).length', context), 1);
});

test('drawer, list toggle and column edits send the selected identity for same-named tables', async () => {
  const requests = [];
  const context = { window: {}, console,
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ status: 'success' }) };
    } };
  vm.createContext(context);
  const source = fs.readFileSync('src/frontend/js/modules/dictionary.js', 'utf8');
  vm.runInContext(source, context);
  const first = { tableId: 'one::db::dbo::same', tableName: 'Same', isActive: true, columns: [{ columnName: 'ID' }] };
  const second = { tableId: 'two::db::dbo::same', tableName: 'Same', isActive: true, columns: [{ columnName: 'ID' }] };
  Object.assign(context.window, { groupedTablesData: [first, second], selectedDictionaryTableId: second.tableId,
    selectedDictionaryTableName: second.tableName });
  context.renderDataDictionary = () => {};
  context.renderDictionaryDrawer = () => {};
  await context.toggleSelectedDictionaryTableActive(false);
  await context.toggleDictionaryTableActiveFromList(encodeURIComponent(second.tableId), { checked: true });
  await context.saveDictionaryColumnDescription('ID');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => request.body.tableId === second.tableId));
  assert.equal(first.isActive, true);
  assert.equal(first.columns[0].description, undefined);
  assert.equal(second.columns[0].description, '');
  assert.match(source, /toggleDictionaryTableActiveFromList\('\$\{encodedId\}'/);
});
