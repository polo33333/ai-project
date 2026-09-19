'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSqlAgainstJoinPlan } = require('../src/backend/services/sql_join_validator');

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

test('join validator rejects tables outside the backend plan', () => {
  const result = validateSqlAgainstJoinPlan('SELECT o.ID FROM Orders o JOIN Secrets s ON o.CustomerID = s.ID', plan);
  assert.equal(result.valid, false);
  assert.match(result.error, /ngoài JOIN plan/);
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
