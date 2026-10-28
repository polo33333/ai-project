'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const coverage = require('../src/backend/agent/pipeline/coverage');
const { compile } = require('../src/backend/agent/pipeline/query_compiler');

const terms = [
  { value: 'Đang xử lý', ref: 'T_Feedback.StatusID->ConstantName', role: 'Trạng thái' },
  { value: 'Tiếp nhận', ref: 'T_Feedback.StatusID->ConstantName', role: 'Trạng thái' },
  { value: 'Kỳ 1', ref: 'T_Invoice.PeriodID->Name', role: 'Kỳ' }, { value: 'Kỳ 12', ref: 'T_Invoice.PeriodID->Name', role: 'Kỳ' },
  { value: 'Nữ', ref: 'M_Employee.GenderID->ConstantName', role: 'Giới tính' }];

test('named lookup values in the question must reach a filter', () => {
  assert.match(coverage.check({ filters: [] }, 'Có bao nhiêu phản ánh đang xử lý?', terms)[0], /"Đang xử lý" \(Trạng thái: T_Feedback\.StatusID->ConstantName\)/);
  assert.deepEqual(coverage.check({ filters: [{ ref: 'T_Feedback.StatusID->ConstantName', operator: 'eq', value: 'Đang xử lý', evidence: 'đang xử lý' }] },
    'Có bao nhiêu phản ánh đang xử lý?', terms), []);
  assert.match(coverage.check({ filters: [] }, 'Có bao nhiêu nhân viên nữ?', terms)[0], /"Nữ"/);
  // "Kỳ 1" inside "Kỳ 12" is one value, and plain words are not values.
  assert.match(coverage.check({ filters: [] }, 'Tiền của Kỳ 12', terms)[0], /"Kỳ 12"/);
  assert.ok(!/"Kỳ 1"/.test(coverage.check({ filters: [] }, 'Tiền của Kỳ 12', terms)[0]));
  assert.deepEqual(coverage.check({ filters: [] }, 'Danh sách nhân viên kèm giới tính', terms), []);
  // The model may state that a matching word is not a criterion.
  assert.deepEqual(coverage.check({ filters: [], ignoredTerms: ['nữ'] }, 'Cửa hàng Nữ Hoàng có mấy hóa đơn?', terms), []);
});

test('an exclusion in the question needs a ne/notIn filter', () => {
  assert.match(coverage.check({ filters: [] }, 'Nhân viên phòng CSKH trừ Demo3', [])[0], /excludes something \("trừ"\)/);
  assert.deepEqual(coverage.check({ filters: [{ ref: 'M_Employee.EmployeeName', operator: 'ne', value: 'Demo3', evidence: 'trừ Demo3' }] }, 'Nhân viên phòng CSKH trừ Demo3', []), []);
});

test('exclusions keep records whose lookup is empty', () => {
  const columns = list => new Map(list.map(([name, type, label = '']) => [name.toLowerCase(), { name, type, label, pk: false }]));
  const catalog = { dbSourceId: 's', relations: [{ id: 'r', fromTable: 'T_Feedback', toTable: 'M_Constant', pairs: [{ source: 'StatusID', target: 'ConstantID' }], role: 'Trạng thái', display: 'ConstantName' }],
    tables: new Map([['t_feedback', { tableId: 'f', tableName: 'T_Feedback', schemaName: 'dbo', label: '', defaults: ['FeedbackID'], columns: columns([['FeedbackID', 'int'], ['StatusID', 'smallint']]) }],
      ['m_constant', { tableId: 'c', tableName: 'M_Constant', schemaName: 'dbo', label: '', defaults: [], columns: columns([['ConstantID', 'int'], ['ConstantName', 'nvarchar', 'Tên']]) }]]) };
  const { sql, scope } = compile({ root: 'T_Feedback', operation: 'aggregate', measures: [{ ref: '*', aggregation: 'COUNT' }],
    filters: [{ ref: 'T_Feedback.StatusID->ConstantName', operator: 'notIn', values: ['Tiếp nhận'], evidence: 'không phải trạng thái Tiếp nhận' }] }, catalog,
    { question: 'Số phản ánh không phải trạng thái Tiếp nhận' });
  assert.match(sql, /WHERE \(t1\.\[ConstantName\] NOT IN \(N'Tiếp nhận'\) OR t1\.\[ConstantName\] IS NULL\)/);
  assert.deepEqual(scope, ['Trạng thái không phải: Tiếp nhận']);
});

test('roles named in the question add the list column or the grouping', () => {
  const { applyRoles } = require('../src/backend/agent/pipeline/contract_pipeline');
  const catalog = { relations: [{ fromTable: 'T_Invoice', toTable: 'M_Customer', pairs: [{ source: 'CustomerID', target: 'CustomerID' }], role: 'Khách hàng', display: 'CustomerName' },
    { fromTable: 'T_Invoice', toTable: 'M_Constant', pairs: [{ source: 'StatusID', target: 'ConstantID' }], role: 'Trạng thái', display: 'ConstantName' }],
    tables: new Map([['t_invoice', { tableName: 'T_Invoice', defaults: ['InvoiceID'], columns: new Map() }]]) };
  const list = { root: 'T_Invoice', operation: 'list', filters: [] };
  assert.deepEqual(applyRoles(list, 'Hóa đơn Kỳ 3 gồm những khách hàng nào?', catalog), ['field:T_Invoice.CustomerID']);
  assert.deepEqual(list.fields, ['T_Invoice.InvoiceID', 'T_Invoice.CustomerID']);
  const grouped = { root: 'T_Invoice', operation: 'aggregate', measures: [{ ref: '*', aggregation: 'COUNT' }] };
  assert.deepEqual(applyRoles(grouped, 'Thống kê số hóa đơn theo trạng thái', catalog), ['groupBy:T_Invoice.StatusID']);
  // Already grouped through the lookup: nothing added.
  assert.deepEqual(applyRoles({ ...grouped, groupBy: [{ ref: 'T_Invoice.StatusID->ConstantName' }] }, 'Thống kê theo trạng thái', catalog), []);
});

test('several periods compile to a union of half-open ranges', () => {
  const columns = new Map([['docdate', { name: 'DocDate', type: 'datetime', label: 'Ngày' }], ['amount', { name: 'Amount', type: 'float', label: 'Tiền' }]]);
  const catalog = { dbSourceId: 's', relations: [], tables: new Map([['t_invoice', { tableId: 'i', tableName: 'T_Invoice', schemaName: 'dbo', label: '', defaults: [], columns }]]) };
  const { sql } = compile({ root: 'T_Invoice', operation: 'aggregate', measures: [{ ref: 'Amount', aggregation: 'SUM' }], groupBy: [{ ref: 'DocDate', grain: 'month' }],
    filters: [{ ref: 'DocDate', operator: 'period', values: ['2024-01', '2024-02'], evidence: '2024-01 và 2024-02' }] }, catalog, { question: 'So sánh 2024-01 và 2024-02' });
  assert.match(sql, /WHERE \(\(t0\.\[DocDate\] >= '2024-01-01' AND t0\.\[DocDate\] < '2024-02-01'\) OR \(t0\.\[DocDate\] >= '2024-02-01' AND t0\.\[DocDate\] < '2024-03-01'\)\)/);
});

test('the v2 catalog never shows columns blocked by the source policy', () => {
  const { build, describe } = require('../src/backend/agent/pipeline/query_catalog');
  const dictionary = { getGroupedTables: () => [{ tableId: 's::t', tableName: 'T_Staff', dbSourceId: 's', isActive: true, columns: [
    { columnName: 'StaffID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'Salary', dataType: 'MONEY', displayName: 'Lương' },
    { columnName: 'Name', dataType: 'NVARCHAR' }, { columnName: 'Hidden', dataType: 'INT', isVisible: false }] }] };
  const relationships = { verifiedRelationships: () => [] };
  const catalog = build({ dbSourceId: 's', selectedTables: ['T_Staff'], tableDirectory: [{ tableName: 'T_Staff' }] },
    { policy: ['salary'], dictionary, relationships });
  assert.deepEqual([...catalog.tables.get('t_staff').columns.values()].map(column => column.name), ['StaffID', 'Name']);
  assert.ok(!/Salary|Lương|Hidden/.test(describe(catalog)));
});
