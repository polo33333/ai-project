'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSqlAgainstJoinPlan } = require('../src/backend/services/sql_join_validator');
const dictionaryService = require('../src/backend/services/dictionary_service');
const { withIdentity } = require('../src/backend/services/schema_identity');

const plan = {
  outcome: 'ready',
  tableRefs: [
    { tableId: 'orders', tableName: 'Orders' },
    { tableId: 'customers', tableName: 'Customers' }
  ],
  edges: [{ relationshipId: 'order_customer', fromTableId: 'orders', toTableId: 'customers', columnPairs: [
    { sourceColumn: 'TenantID', targetColumn: 'TenantID' },
    { sourceColumn: 'CustomerID', targetColumn: 'ID' }
  ] }]
};

test('join validator accepts all ordered composite key predicates', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM dbo.Orders o JOIN dbo.Customers c ON o.TenantID = c.TenantID AND o.CustomerID = c.ID', plan);
  assert.equal(result.valid, true);
});

test('join validator rejects a missing composite key predicate', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Customers c ON o.CustomerID = c.ID', plan);
  assert.equal(result.valid, false);
  assert.match(result.error, /thiếu đủ khóa JOIN/);
});

test('join validator rejects a key hidden below OR', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Customers c ON o.TenantID = c.TenantID AND (o.CustomerID = c.ID OR 1 = 1)', plan);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'JOIN_UNSUPPORTED_SQL');
});

test('join validator validates every alias instead of accepting one valid edge for the table', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Customers c ON o.TenantID = c.TenantID AND o.CustomerID = c.ID JOIN Customers c2 ON 1 = 1', plan);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'JOIN_RELATIONSHIP_MISSING');
});

test('join validator accepts a verified relationship fallback when the aggregate plan is ambiguous', () => {
  const oldTables = dictionaryService.tablesStore;
  const oldRelations = dictionaryService.tableRelationships;
  const tables = ['Orders', 'Customers'].map(tableName => withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', tableName,
    isActive: true, columns: [{ columnName: tableName === 'Orders' ? 'CustomerID' : 'ID' }] }));
  dictionaryService.tablesStore = tables;
  dictionaryService.tableRelationships = [{ id: 'fallback-r', sourceTableId: tables[0].tableId, targetTableId: tables[1].tableId,
    sourceTable: 'Orders', targetTable: 'Customers', columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'ID' }],
    status: 'verified', isActive: true, revision: 1, cardinality: 'many-to-one' }];
  try {
    const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Customers c ON o.CustomerID = c.ID', {
      outcome: 'ambiguous', dbSourceId: 'src', allowedTableIds: tables.map(table => table.tableId)
    });
    assert.equal(result.valid, true);
  } finally {
    dictionaryService.tablesStore = oldTables;
    dictionaryService.tableRelationships = oldRelations;
  }
});

test('join validator rejects tables outside the backend plan', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Secrets s ON o.CustomerID = s.ID', plan);
  assert.equal(result.valid, false);
  assert.match(result.error, /ngoài JOIN plan/);
});

test('join validator rejects a same-named table from another schema', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM audit.Orders o JOIN dbo.Customers c ON o.TenantID = c.TenantID AND o.CustomerID = c.ID', plan);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'JOIN_SCOPE_DENIED');
});

test('AST validator rejects malformed T-SQL instead of falling back', () => {
  const result = validateSqlAgainstJoinPlan('SELECT FROM Orders o JOIN Customers c ON o.CustomerID = c.ID', plan);
  assert.equal(result.valid, false);
  assert.match(result.error, /Không phân tích được cú pháp|chỉ cho phép đúng một câu/);
});

test('aggregate validator rejects parent SUM across a one-to-many join', () => {
  const aggregatePlan = { ...plan, edges: [{ ...plan.edges[0], cardinality: 'one-to-many', columnPairs: [{ sourceColumn: 'ID', targetColumn: 'OrderID' }] }] };
  const result = validateSqlAgainstJoinPlan('SELECT SUM(o.Total) FROM Orders o JOIN Customers c ON o.ID = c.OrderID', aggregatePlan);
  assert.equal(result.valid, false);
  assert.match(result.error, /SUM cột bảng cha/);
});

test('aggregate validator accepts COUNT DISTINCT parent entity', () => {
  const aggregatePlan = { ...plan, edges: [{ ...plan.edges[0], cardinality: 'one-to-many', columnPairs: [{ sourceColumn: 'ID', targetColumn: 'OrderID' }] }] };
  const result = validateSqlAgainstJoinPlan('SELECT COUNT(DISTINCT o.ID) FROM Orders o JOIN Customers c ON o.ID = c.OrderID', aggregatePlan);
  assert.equal(result.valid, true);
});

test('aggregate validator rejects parent AVG across a one-to-many join', () => {
  const aggregatePlan = { ...plan, edges: [{ ...plan.edges[0], cardinality: 'one-to-many', columnPairs: [{ sourceColumn: 'ID', targetColumn: 'OrderID' }] }] };
  const result = validateSqlAgainstJoinPlan('SELECT AVG(o.Total) FROM Orders o JOIN Customers c ON o.ID = c.OrderID', aggregatePlan);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'JOIN_GRAIN_UNSAFE');
});

test('grain validator rejects a parent list that would fan out', () => {
  const aggregatePlan = { ...plan, rootTableId: 'orders', expectedGrain: 'root',
    edges: [{ ...plan.edges[0], cardinality: 'one-to-many', columnPairs: [{ sourceColumn: 'ID', targetColumn: 'OrderID' }] }] };
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Customers c ON o.ID = c.OrderID', aggregatePlan);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'JOIN_GRAIN_UNSAFE');
});

test('enrichment validator rejects mapped source IDs in the result projection', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      fromTableId: 'employee', toTableId: 'constant', businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const result = validateSqlAgainstJoinPlan('SELECT e.EmployeeName, e.GenderID, c.ConstantName AS [Giới tính] FROM M_Employee e LEFT JOIN M_Constant c ON e.GenderID = c.ConstantID', enrichmentPlan);
  assert.equal(result.valid, false);
  assert.match(result.error, /không được hiển thị ID đã map/);
});

test('enrichment validator accepts display values with the configured business-role header', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      fromTableId: 'employee', toTableId: 'constant', businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const result = validateSqlAgainstJoinPlan('SELECT e.EmployeeName, c.ConstantName AS [Giới tính] FROM M_Employee e LEFT JOIN M_Constant c ON e.GenderID = c.ConstantID', enrichmentPlan);
  assert.equal(result.valid, true);
});

test('enrichment validator binds each shared lookup role to its own SQL alias', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment', rootTableId: 'contract', expectedGrain: 'root',
    tableRefs: [
      { tableRefId: 'contract#1', tableId: 'contract', tableName: 'T_Contract' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'T_Constant' },
      { tableRefId: 'constant#3', tableId: 'constant', tableName: 'T_Constant' }
    ],
    edges: [
      { relationshipId: 'contract_type', fromTableRefId: 'contract#1', toTableRefId: 'constant#2', fromTableId: 'contract', toTableId: 'constant',
        businessRole: 'Loại hợp đồng', displayColumn: 'ConstantName', cardinality: 'many-to-one', columnPairs: [{ sourceColumn: 'TypeID', targetColumn: 'ID' }] },
      { relationshipId: 'contract_status', fromTableRefId: 'contract#1', toTableRefId: 'constant#3', fromTableId: 'contract', toTableId: 'constant',
        businessRole: 'Trạng thái', displayColumn: 'ConstantName', cardinality: 'many-to-one', columnPairs: [{ sourceColumn: 'StatusID', targetColumn: 'ID' }] }
    ]
  };
  const valid = validateSqlAgainstJoinPlan('SELECT c.Code, ty.ConstantName AS [Loại hợp đồng], st.ConstantName AS [Trạng thái] FROM T_Contract c LEFT JOIN T_Constant ty ON c.TypeID = ty.ID LEFT JOIN T_Constant st ON c.StatusID = st.ID', enrichmentPlan);
  assert.equal(valid.valid, true);
  const swapped = validateSqlAgainstJoinPlan('SELECT c.Code, ty.ConstantName AS [Trạng thái], st.ConstantName AS [Loại hợp đồng] FROM T_Contract c LEFT JOIN T_Constant ty ON c.TypeID = ty.ID LEFT JOIN T_Constant st ON c.StatusID = st.ID', enrichmentPlan);
  assert.equal(swapped.valid, false);
  assert.equal(swapped.code, 'JOIN_PROJECTION_INVALID');
});

test('enrichment validator allows a compact lookup that does not project mapped IDs', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      fromTableId: 'employee', toTableId: 'constant', businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const result = validateSqlAgainstJoinPlan("SELECT EmployeeID, EmployeeCode, EmployeeName FROM M_Employee WHERE EmployeeName LIKE N'%Duy%'", enrichmentPlan);
  assert.equal(result.valid, true);
});

test('enrichment validator requires the mapped table when a mapped ID is projected', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      fromTableId: 'employee', toTableId: 'constant', businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const result = validateSqlAgainstJoinPlan('SELECT EmployeeName, GenderID FROM M_Employee', enrichmentPlan);
  assert.equal(result.valid, false);
  assert.match(result.error, /M_Constant/);
});

test('enrichment validator rejects wildcard projections that expose mapped IDs', () => {
  const enrichmentPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      fromTableId: 'employee', toTableId: 'constant', businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const result = validateSqlAgainstJoinPlan('SELECT e.*, c.ConstantName AS [Giới tính] FROM M_Employee e LEFT JOIN M_Constant c ON e.GenderID = c.ConstantID', enrichmentPlan);
  assert.equal(result.valid, false);
  assert.match(result.error, /không được hiển thị ID đã map/);
});
