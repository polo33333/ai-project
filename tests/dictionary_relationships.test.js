'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DictionaryService } = require('../src/backend/services/dictionary_service');
const { withIdentity } = require('../src/backend/services/schema_identity');
const sqlConnector = require('../src/backend/services/sql_connector');

function serviceFixture() {
  const service = new DictionaryService();
  service.tablesStore = [
    withIdentity({ dbSourceId: 'source-a', dbName: 'ERP', schemaName: 'dbo', tableName: 'Employees', columns: [
      { columnName: 'TenantID', dataType: 'INT' }, { columnName: 'DepartmentID', dataType: 'INT' }
    ] }),
    withIdentity({ dbSourceId: 'source-a', dbName: 'ERP', schemaName: 'dbo', tableName: 'Departments', columns: [
      { columnName: 'TenantID', dataType: 'INT' }, { columnName: 'DepartmentID', dataType: 'INT', isPrimaryKey: true },
      { columnName: 'DepartmentName', dataType: 'NVARCHAR' }
    ] }),
    withIdentity({ dbSourceId: 'source-b', dbName: 'ERP', schemaName: 'dbo', tableName: 'Departments', columns: [
      { columnName: 'DepartmentID', dataType: 'INT' }
    ] })
  ];
  service.tableRelationships = [];
  service.persist = () => {};
  service.qdrantSyncCalls = 0;
  service.syncToQdrant = async () => { service.qdrantSyncCalls += 1; return { success: true }; };
  return service;
}

test('field mapping stores identity, ordered column pairs and suggested lifecycle', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  const relation = await service.addTableRelationship({
    sourceTableId: employees.tableId,
    targetTableId: departments.tableId,
    columnPairs: [
      { sourceColumn: 'TenantID', targetColumn: 'TenantID' },
      { sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }
    ],
    cardinality: 'many-to-one',
    businessRole: 'employee_department',
    displayColumn: 'DepartmentName',
    preferred: true
  });
  assert.equal(relation.sourceTableId, employees.tableId);
  assert.equal(relation.targetTableId, departments.tableId);
  assert.deepEqual(relation.columnPairs.map(pair => pair.sourceColumn), ['TenantID', 'DepartmentID']);
  assert.equal(relation.status, 'suggested');
  assert.equal(relation.revision, 1);
  assert.equal(relation.displayColumn, 'DepartmentName');
  assert.equal(relation.preferred, true);
  assert.equal(service.qdrantSyncCalls, 0);
});

test('relationship rejects a display column outside the target table', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  await assert.rejects(service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }], displayColumn: 'MissingName' }), /Cột hiển thị/);
});

test('Qdrant sync runs only when a relationship enters or leaves the verified set', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  assert.equal(service.qdrantSyncCalls, 0);
  const updated = await service.updateTableRelationship(relation.id, { expectedRevision: 1, businessRole: 'department' });
  assert.equal(service.qdrantSyncCalls, 0);
  const verified = await service.setTableRelationshipStatus(relation.id, 'verified', updated.revision);
  assert.equal(service.qdrantSyncCalls, 1);
  await service.setTableRelationshipStatus(relation.id, 'rejected', verified.revision);
  assert.equal(service.qdrantSyncCalls, 2);
});

test('relationship mapping rejects cross-source targets and direct many-to-many edges', async () => {
  const service = serviceFixture();
  const [employees, , otherDepartments] = service.tablesStore;
  await assert.rejects(service.addTableRelationship({
    sourceTableId: employees.tableId, targetTableId: otherDepartments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }]
  }), /cùng nguồn/);
  await assert.rejects(service.addTableRelationship({
    sourceTableId: employees.tableId, targetTableId: service.tablesStore[1].tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }], cardinality: 'many-to-many'
  }), /bảng trung gian/);
});

test('relationship update uses optimistic revision', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  await assert.rejects(service.updateTableRelationship(relation.id, { expectedRevision: 0 }), /phiên làm việc khác/);
  const updated = await service.updateTableRelationship(relation.id, { expectedRevision: 1, businessRole: 'department' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.businessRole, 'department');
});

test('only explicit lifecycle action verifies a relationship', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  const verified = await service.setTableRelationshipStatus(relation.id, 'verified', 1);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.revision, 2);
  assert.ok(verified.verifiedAt);
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'rejected', 1), /phiên làm việc khác/);
});

test('manual relationship cannot be verified without uniqueness evidence for its cardinality', async () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  departments.columns.find(column => column.columnName === 'DepartmentID').isPrimaryKey = false;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }], cardinality: 'many-to-one' });
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', 1), error => {
    assert.equal(error.code, 'JOIN_CARDINALITY_UNCONFIRMED');
    return true;
  });
});

test('profiling records a cardinality mismatch and refuses verification', async t => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  departments.columns.find(column => column.columnName === 'DepartmentID').isPrimaryKey = false;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }], cardinality: 'many-to-one' });
  const original = sqlConnector.executeSqlQuery;
  let calls = 0;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  sqlConnector.executeSqlQuery = async () => (++calls === 1
    ? [{ totalRows: 10, nullKeyRows: 0, orphanRows: 0 }]
    : [{ duplicateKeys: 2 }]);
  const profiled = await service.profileTableRelationship(relation.id, 1);
  assert.equal(profiled.evidence.cardinalityStatus, 'mismatch');
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', profiled.revision), error => {
    assert.equal(error.code, 'JOIN_CARDINALITY_MISMATCH');
    return true;
  });
});

test('schema sync imports trusted composite foreign keys idempotently and marks changed keys stale', () => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  service.tableRelationships = [];
  const snapshot = [
    { ...employees, columns: employees.columns, foreignKeys: [{ constraintName: 'FK_Employee_Department', targetSchema: 'dbo', targetTable: 'Departments',
      isDisabled: false, isNotTrusted: false, columnPairs: [{ sourceColumn: 'TenantID', targetColumn: 'TenantID' }, { sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] }] },
    { ...departments, columns: departments.columns }
  ];
  service.saveDictionaryItems(snapshot);
  assert.equal(service.tableRelationships.length, 1);
  assert.equal(service.tableRelationships[0].status, 'verified');
  assert.equal(service.tableRelationships[0].verifiedBy, 'system');
  const revision = service.tableRelationships[0].revision;
  service.saveDictionaryItems(snapshot);
  assert.equal(service.tableRelationships.length, 1);
  assert.equal(service.tableRelationships[0].revision, revision);
  service.saveDictionaryItems([{ ...employees, columns: employees.columns.map(column => column.columnName === 'DepartmentID' ? { ...column, dataType: 'BIGINT' } : column) }]);
  assert.equal(service.tableRelationships[0].status, 'stale');
});

test('many-to-many mapping is stored atomically as two suggested bridge edges', async () => {
  const service = serviceFixture();
  const source = service.tablesStore[0];
  const target = service.tablesStore[1];
  const bridge = withIdentity({ dbSourceId: 'source-a', dbName: 'ERP', schemaName: 'dbo', tableName: 'EmployeeDepartments', columns: [
    { columnName: 'EmployeeID', dataType: 'INT' }, { columnName: 'DepartmentID', dataType: 'INT' }
  ] });
  source.columns.push({ columnName: 'EmployeeID', dataType: 'INT' });
  service.tablesStore.push(bridge);
  const created = await service.addManyToManyRelationship({ sourceTableId: source.tableId, targetTableId: target.tableId, bridgeTableId: bridge.tableId,
    sourceToBridgePairs: [{ sourceColumn: 'EmployeeID', targetColumn: 'EmployeeID' }],
    bridgeToTargetPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }], businessRole: 'employee_department' });
  assert.equal(created.length, 2);
  assert.equal(created[0].manyToManyGroupId, created[1].manyToManyGroupId);
  assert.deepEqual(created.map(item => item.cardinality), ['one-to-many', 'many-to-one']);
  assert.equal(created.every(item => item.status === 'suggested'), true);
});

test('convention discovery creates only a suggested candidate behind its feature flag', async t => {
  const previous = process.env.SQL_RELATIONSHIP_DISCOVERY_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.SQL_RELATIONSHIP_DISCOVERY_ENABLED; else process.env.SQL_RELATIONSHIP_DISCOVERY_ENABLED = previous; });
  process.env.SQL_RELATIONSHIP_DISCOVERY_ENABLED = 'true';
  const service = serviceFixture();
  service.tablesStore[1].tableName = 'M_Department';
  service.tablesStore[1] = withIdentity(service.tablesStore[1]);
  service.tableRelationships = [];
  const created = await service.discoverRelationshipCandidates({ dbSourceId: 'source-a', dbName: 'ERP' });
  assert.equal(created.length, 1);
  assert.equal(created[0].origin, 'inferred');
  assert.equal(created[0].status, 'suggested');
});

test('relationship profiling stores aggregate evidence without source values', async t => {
  const service = serviceFixture();
  const [employees, departments] = service.tablesStore;
  const relation = await service.addTableRelationship({ sourceTableId: employees.tableId, targetTableId: departments.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  const original = sqlConnector.executeSqlQuery;
  let calls = 0;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  sqlConnector.executeSqlQuery = async () => (++calls === 1
    ? [{ totalRows: 10, nullKeyRows: 2, orphanRows: 1 }]
    : [{ duplicateKeys: 0 }]);
  const profiled = await service.profileTableRelationship(relation.id, 1);
  assert.match(profiled.evidence.profile.signature, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...profiled.evidence.profile, signature: 'ignored', checkedAt: 'ignored' }, {
    signature: 'ignored',
    scope: 'full', checkedAt: 'ignored', totalRows: 10, nullKeyRows: 2, orphanRows: 1, duplicateTargetKeys: 0
  });
  assert.equal(profiled.revision, 2);
});

test('metadata writes cannot forge lifecycle, foreign key provenance or profiling evidence', async () => {
  const service = serviceFixture();
  const [source, target] = service.tablesStore;
  target.columns.forEach(c => { c.isPrimaryKey = false; });
  const forged = { status: 'verified', origin: 'foreign_key', verifiedBy: 'admin',
    evidence: { profile: { duplicateTargetKeys: 0 } } };
  const relation = await service.addTableRelationship({ ...forged, sourceTableId: source.tableId,
    targetTableId: target.tableId, columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  assert.equal(relation.status, 'suggested');
  assert.equal(relation.origin, 'manual');
  assert.equal(relation.evidence, undefined);
  await service.updateTableRelationship(relation.id, { ...forged, id: 'replacement', revision: 100 });
  assert.equal(relation.status, 'suggested');
  assert.equal(relation.origin, 'manual');
  assert.equal(relation.revision, 2);
  assert.notEqual(relation.id, 'replacement');
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', 2), { code: 'JOIN_CARDINALITY_UNCONFIRMED' });
});

test('composite, filtered and disabled indexes do not prove individual-column uniqueness', () => {
  const service = serviceFixture();
  const table = { columns: [{ columnName: 'A', isUnique: true }, { columnName: 'B', isUnique: true }],
    uniqueConstraints: [{ columnNames: ['A', 'B'] }, { columnNames: ['A'], hasFilter: true },
      { columnNames: ['B'], isDisabled: true }] };
  assert.equal(service.tableColumnsAreUnique(table, ['A']), false);
  assert.equal(service.tableColumnsAreUnique(table, ['B']), false);
  assert.equal(service.tableColumnsAreUnique(table, ['A', 'B']), true);
  delete table.uniqueConstraints;
  assert.equal(service.tableColumnsAreUnique(table, ['A']), false);
});

test('only an explicit FK snapshot retires removed constraints and prevents re-verification', async () => {
  const service = serviceFixture();
  const [source] = service.tablesStore;
  const fk = { constraintName: 'FK_Test', targetTable: 'Departments',
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] };
  service.saveDictionaryItems([{ ...source, foreignKeys: [fk] }]);
  const relation = service.tableRelationships[0];
  service.saveDictionaryItems([{ ...source }]); // Partial DDL has no FK inventory.
  assert.equal(relation.status, 'verified');
  service.saveDictionaryItems([{ ...source, foreignKeys: [] }]);
  assert.equal(relation.status, 'stale');
  assert.equal(relation.evidence.missing, true);
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', relation.revision), { code: 'JOIN_FOREIGN_KEY_UNTRUSTED' });
  const revision = relation.revision;
  service.saveDictionaryItems([{ ...source, foreignKeys: [] }]);
  assert.equal(relation.revision, revision);
});

test('complete refresh retires missing tables only in the selected source and preserves descriptions', () => {
  const service = serviceFixture();
  const [source, target, other] = service.tablesStore;
  source.columns[0].description = 'Tenant do người dùng mô tả';
  service.saveDictionaryItems([{ ...source, columns: source.columns.map(c => ({ ...c, description: 'Generated' })) }],
    { completeSourceId: source.dbSourceId });
  assert.equal(target.schemaMissing, true);
  assert.equal(target.isActive, false);
  assert.equal(other.schemaMissing, undefined);
  assert.equal(source.columns[0].description, 'Tenant do người dùng mô tả');
});

test('profiling uses source counts without JOIN fanout and invalidates evidence after structure changes', async t => {
  const service = serviceFixture();
  const [source, target] = service.tablesStore;
  target.columns.forEach(c => { c.isPrimaryKey = false; });
  const relation = await service.addTableRelationship({ sourceTableId: source.tableId, targetTableId: target.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  const original = sqlConnector.executeSqlQuery;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  const queries = [];
  sqlConnector.executeSqlQuery = async sql => {
    queries.push(sql);
    return sql.includes('AS totalRows') ? [{ totalRows: 5, nullKeyRows: 1, orphanRows: 1 }] : [{ duplicateKeys: 0 }];
  };
  await service.profileTableRelationship(relation.id, relation.revision);
  assert.match(queries[0], /NOT EXISTS/);
  assert.doesNotMatch(queries[0], /LEFT JOIN/);
  await service.setTableRelationshipStatus(relation.id, 'verified', relation.revision);
  await service.updateTableRelationship(relation.id, { columnPairs: [{ sourceColumn: 'TenantID', targetColumn: 'TenantID' }] });
  assert.equal(relation.status, 'stale');
  assert.equal(relation.evidence.profile, undefined);
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', relation.revision), { code: 'JOIN_CARDINALITY_UNCONFIRMED' });
});

test('expired profiling cannot verify a relation and async profiling rejects concurrent edits', async t => {
  const service = serviceFixture();
  const [source, target] = service.tablesStore;
  target.columns.forEach(c => { c.isPrimaryKey = false; });
  const relation = await service.addTableRelationship({ sourceTableId: source.tableId, targetTableId: target.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  relation.evidence = { profile: { signature: service.profileSignature(relation),
    checkedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), duplicateTargetKeys: 0 } };
  await assert.rejects(service.setTableRelationshipStatus(relation.id, 'verified', relation.revision), { code: 'JOIN_CARDINALITY_UNCONFIRMED' });
  const original = sqlConnector.executeSqlQuery;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  let changed = false;
  sqlConnector.executeSqlQuery = async () => {
    if (!changed) { changed = true; await service.updateTableRelationship(relation.id, { businessRole: 'new' }); }
    return [{ totalRows: 1, duplicateKeys: 0 }];
  };
  await assert.rejects(service.profileTableRelationship(relation.id, relation.revision), { statusCode: 409 });
});

test('legacy mutations reject ambiguous names and accept exact table identities', async () => {
  const service = serviceFixture();
  const [, first, second] = service.tablesStore;
  await assert.rejects(service.toggleTableActive('Departments', false), /tableId/);
  await assert.rejects(service.updateColumnDescription('Departments', 'DepartmentID', 'New'), /tableId/);
  await assert.rejects(service.deleteTable('Departments'), /tableId/);
  await service.toggleTableActive('Departments', false, second.tableId);
  assert.notEqual(first.isActive, false);
  assert.equal(second.isActive, false);
  await service.updateColumnDescription('Departments', 'DepartmentID', 'Second source', '', second.tableId);
  assert.equal(second.columns[0].description, 'Second source');
  assert.notEqual(first.columns[1].description, 'Second source');
});

test('incomplete profiling results cannot become uniqueness evidence', async t => {
  const service = serviceFixture();
  const [source, target] = service.tablesStore;
  const relation = await service.addTableRelationship({ sourceTableId: source.tableId, targetTableId: target.tableId,
    columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'DepartmentID' }] });
  const original = sqlConnector.executeSqlQuery;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  sqlConnector.executeSqlQuery = async sql => sql.includes('AS totalRows')
    ? [{ totalRows: 10, nullKeyRows: 0, orphanRows: 0 }] : [];
  await assert.rejects(service.profileTableRelationship(relation.id, 1), { code: 'JOIN_PROFILE_INCOMPLETE' });
  assert.equal(relation.evidence, undefined);
  assert.equal(relation.revision, 1);
});
