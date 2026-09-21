'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dictionaryService = require('../src/backend/services/dictionary_service');
const { withIdentity } = require('../src/backend/services/schema_identity');
const { validateIntentPlan, validateSqlAgainstIntent } = require('../src/backend/services/data_intent_service');
const { PlanDataQueryTool, ExecuteSqlTool } = require('../src/backend/agent_core/tools/builtins');
const sqlConnector = require('../src/backend/services/sql_connector');

async function fixture(run) {
  const oldTables = dictionaryService.tablesStore;
  const employee = withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', tableName: 'M_Employee', isActive: true,
    columns: [{ columnName: 'EmployeeID', isPrimaryKey: true }, { columnName: 'EmployeeName' }, { columnName: 'GenderID' }] });
  const constant = withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', tableName: 'M_Constant', isActive: true,
    columns: [{ columnName: 'ConstantID', isPrimaryKey: true }, { columnName: 'ConstantName' }] });
  dictionaryService.tablesStore = [employee, constant];
  const joinPlan = { outcome: 'ready', dbSourceId: 'src', allowedTableIds: [employee.tableId, constant.tableId],
    allowedTableNames: ['M_Employee', 'M_Constant'], tableRefs: [
      { tableRefId: 'employee#1', tableId: employee.tableId, tableName: 'M_Employee', schemaName: 'dbo' },
      { tableRefId: 'constant#2', tableId: constant.tableId, tableName: 'M_Constant', schemaName: 'dbo' }
    ], edges: [{ relationshipId: 'employee_gender',
      fromTableId: employee.tableId, toTableId: constant.tableId, businessRole: 'Giới tính', displayColumn: 'ConstantName',
      fromTableRefId: 'employee#1', toTableRefId: 'constant#2', cardinality: 'many-to-one',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }] };
  try { return await run({ employee, constant, joinPlan, context: { dbSourceId: 'src', joinPlan } }); }
  finally { dictionaryService.tablesStore = oldTables; }
}

test('model intent plan maps an attribute value to a verified relationship instead of a person name', () => fixture(({ context }) => {
  const plan = validateIntentPlan({ intent: 'list', rootTable: 'M_Employee', entityLookup: null,
    relationshipFilters: [{ relationshipRole: 'Giới tính', operator: 'contains', value: 'nữ' }],
    requestedFields: ['EmployeeName', 'Giới tính'], resultGrain: 'M_Employee', confidence: 0.95 }, context);
  assert.equal(plan.entityLookup, null);
  assert.equal(plan.relationshipFilters[0].relationshipId, 'employee_gender');
  assert.equal(plan.relationshipFilters[0].value, 'nữ');
}));

test('model intent plan normalizes a mapped foreign-key lookup into a relationship filter', () => fixture(({ context }) => {
  const plan = validateIntentPlan({ intent: 'list', rootTable: 'M_Employee',
    entityLookup: { field: 'GenderID', operator: 'equals', value: 'Nam' }
  }, context);
  assert.equal(plan.entityLookup, null);
  assert.equal(plan.relationshipFilters.length, 1);
  assert.equal(plan.relationshipFilters[0].relationshipId, 'employee_gender');
  assert.equal(plan.relationshipFilters[0].displayColumn, 'ConstantName');
  assert.equal(plan.relationshipFilters[0].value, 'Nam');
}));

test('SQL must apply every relationship filter selected by the model intent plan', () => fixture(({ context, joinPlan }) => {
  const plan = validateIntentPlan({ intent: 'list', rootTable: 'M_Employee',
    relationshipFilters: [{ relationshipRole: 'Giới tính', value: 'nữ' }] }, context);
  const correct = validateSqlAgainstIntent("SELECT e.EmployeeName FROM M_Employee e JOIN M_Constant g ON e.GenderID=g.ConstantID WHERE g.ConstantName LIKE N'%nữ%'", plan, joinPlan);
  assert.equal(correct.valid, true);
  const wrong = validateSqlAgainstIntent("SELECT EmployeeName FROM M_Employee WHERE EmployeeName LIKE N'%nào giới tính nữ%'", plan, joinPlan);
  assert.equal(wrong.valid, false);
  assert.equal(wrong.code, 'DATA_INTENT_SQL_MISMATCH');
}));

test('intent plan rejects invented relationship roles and fields', () => fixture(({ context }) => {
  assert.throws(() => validateIntentPlan({ intent: 'list', rootTable: 'M_Employee',
    relationshipFilters: [{ relationshipRole: 'Cung hoàng đạo', value: 'Sư tử' }] }, context),
  error => error.code === 'DATA_INTENT_RELATIONSHIP_INVALID');
  assert.throws(() => validateIntentPlan({ intent: 'record_lookup', rootTable: 'M_Employee',
    entityLookup: { field: 'UnknownName', value: 'Duy' } }, context),
  error => error.code === 'DATA_INTENT_FIELD_INVALID');
}));

test('plan_data_query stores the model decision and SQL execution enforces it', async t => fixture(async ({ context }) => {
  const original = sqlConnector.executeSqlQuery;
  t.after(() => { sqlConnector.executeSqlQuery = original; });
  sqlConnector.executeSqlQuery = async () => [{ EmployeeName: 'Lan', 'Giới tính': 'Nữ' }];
  Object.assign(context, { requireModelIntentPlan: true, permissions: ['sql:read'] });
  const planned = await new PlanDataQueryTool().execute({ intent: 'list', rootTable: 'M_Employee',
    relationshipFilters: [{ relationshipRole: 'Giới tính', value: 'nữ' }], resultGrain: 'M_Employee' }, context);
  assert.equal(planned.success, true);
  assert.equal(context.modelIntentPlan.relationshipFilters[0].relationshipId, 'employee_gender');
  const rejected = await new ExecuteSqlTool().execute({
    sql: "SELECT EmployeeName FROM M_Employee WHERE EmployeeName LIKE N'%nào giới tính nữ%'"
  }, context);
  assert.equal(rejected.success, false);
  assert.equal(rejected.code, 'DATA_INTENT_SQL_MISMATCH');
  const accepted = await new ExecuteSqlTool().execute({
    sql: "SELECT e.EmployeeName, g.ConstantName AS [Giới tính] FROM dbo.M_Employee e JOIN dbo.M_Constant g ON e.GenderID=g.ConstantID WHERE g.ConstantName LIKE N'%nữ%'"
  }, context);
  assert.equal(accepted.success, true);
  assert.equal(accepted.result.rowCount, 1);
}));
