'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dictionaryService = require('../src/backend/services/dictionary_service');
const { createRequestPlan } = require('../src/backend/training_core/request_planner');

test('batch table configuration saves column visibility and syncs once', async () => {
  const previousTables = dictionaryService.tablesStore;
  const previousRelationships = dictionaryService.tableRelationships;
  const previousPersist = dictionaryService.persist;
  const previousSync = dictionaryService.syncToQdrant;
  let persists = 0;
  let syncs = 0;
  try {
    dictionaryService.tablesStore = [{ tableId: 'source::db::dbo::employee', tableName: 'M_Employee', dbName: 'db',
      dbSourceId: 'source', schemaName: 'dbo', isActive: true, columns: [
        { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
        { columnName: 'EmployeeName', dataType: 'nvarchar' }
      ] }];
    dictionaryService.tableRelationships = [];
    dictionaryService.persist = () => { persists++; };
    dictionaryService.syncToQdrant = async () => { syncs++; return { success: true }; };
    await dictionaryService.saveTableConfiguration({ tableId: 'source::db::dbo::employee', table: { isActive: true }, columns: [
      { columnName: 'EmployeeID', isVisible: false, description: 'Internal key' },
      { columnName: 'EmployeeName', isVisible: true, displayName: 'Tên nhân viên' }
    ] });
    assert.equal(persists, 1);
    assert.equal(syncs, 1);
    assert.deepEqual(dictionaryService.getDictionary().map(item => item.columnName), ['EmployeeName']);
    const plan = createRequestPlan({ question: 'ds nhân viên', selectedTables: dictionaryService.tablesStore,
      dictionaryTables: dictionaryService.tablesStore, domainAliases: {} });
    assert.deepEqual(plan.schemaColumns, ['EmployeeName']);
  } finally {
    dictionaryService.tablesStore = previousTables;
    dictionaryService.tableRelationships = previousRelationships;
    dictionaryService.persist = previousPersist;
    dictionaryService.syncToQdrant = previousSync;
  }
});

test('columns without an explicit visibility setting remain visible', () => {
  const previousTables = dictionaryService.tablesStore;
  try {
    dictionaryService.tablesStore = [{ tableName: 'T_Test', dbName: 'db', isActive: true,
      columns: [{ columnName: 'Code', dataType: 'nvarchar' }, { columnName: 'Hidden', dataType: 'int', isVisible: false }] }];
    assert.deepEqual(dictionaryService.getDictionary().map(item => item.columnName), ['Code']);
  } finally {
    dictionaryService.tablesStore = previousTables;
  }
});

test('relationships reject hidden key and display columns', async () => {
  const previousTables = dictionaryService.tablesStore;
  const previousRelationships = dictionaryService.tableRelationships;
  try {
    dictionaryService.tablesStore = [
      { tableId: 'source', tableName: 'T_Source', dbName: 'db', columns: [{ columnName: 'TargetID', isVisible: true }] },
      { tableId: 'target', tableName: 'M_Target', dbName: 'db', columns: [
        { columnName: 'TargetID', isVisible: true }, { columnName: 'TargetName', isVisible: false }
      ] }
    ];
    dictionaryService.tableRelationships = [];
    await assert.rejects(() => dictionaryService.addTableRelationship({ sourceTableId: 'source', targetTableId: 'target',
      columnPairs: [{ sourceColumn: 'TargetID', targetColumn: 'TargetID' }], displayColumn: 'TargetName' }), /đang bị tắt/);
  } finally {
    dictionaryService.tablesStore = previousTables;
    dictionaryService.tableRelationships = previousRelationships;
  }
});
