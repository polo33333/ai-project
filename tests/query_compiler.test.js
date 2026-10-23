'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('../src/backend/agent_core/pipeline/query_compiler');
const { describe } = require('../src/backend/agent_core/pipeline/query_catalog');

const columns = list => new Map(list.map(([name, type, label = '', pk = false]) => [name.toLowerCase(), { name, type, label, pk }]));
const table = (tableName, cols, defaults = []) => [tableName.toLowerCase(), { tableId: `s::${tableName}`, tableName, schemaName: 'dbo', label: '', columns: columns(cols), defaults }];
const catalog = {
  dbSourceId: 's',
  tables: new Map([
    table('T_ElectricityOutput', [['ElectricityOutputID', 'int', 'ID chứng từ', true], ['ElectricityOutputDate', 'datetime', 'Ngày chứng từ'],
      ['CustomerID', 'int'], ['PeriodID', 'int'], ['ElectricityTypeID', 'smallint'], ['TotalQty', 'float', 'Sản lượng'], ['FinalTotalAmount', 'float', 'Tiền sau thuế']], ['ElectricityOutputID']),
    table('M_Customer', [['CustomerID', 'int', '', true], ['CustomerCode', 'nvarchar', 'Mã khách hàng'], ['CustomerName', 'nvarchar', 'Tên khách hàng'], ['TypeID', 'int'], ['IsActive', 'bit', 'Đang hoạt động']]),
    table('M_Master', [['MasterID', 'int', '', true], ['Name', 'nvarchar', 'Tên']]),
    table('M_Constant', [['ConstantID', 'int', '', true], ['ConstantName', 'nvarchar', 'Tên hằng']]),
    table('M_Employee', [['EmployeeID', 'int', '', true], ['EmployeeCode', 'nvarchar', 'Mã NV'], ['EmployeeName', 'nvarchar', 'Tên NV'], ['GenderID', 'int'], ['DepartmentID', 'int']], ['EmployeeCode', 'EmployeeName'])
  ]),
  relations: [
    { id: 'r-customer', fromTable: 'T_ElectricityOutput', toTable: 'M_Customer', pairs: [{ source: 'CustomerID', target: 'CustomerID' }], role: 'Khách hàng', display: 'CustomerName' },
    { id: 'r-period', fromTable: 'T_ElectricityOutput', toTable: 'M_Master', pairs: [{ source: 'PeriodID', target: 'MasterID' }], role: 'Kỳ', display: 'Name' },
    { id: 'r-etype', fromTable: 'T_ElectricityOutput', toTable: 'M_Constant', pairs: [{ source: 'ElectricityTypeID', target: 'ConstantID' }], role: 'Loại điện', display: 'ConstantName' },
    { id: 'r-ctype', fromTable: 'M_Customer', toTable: 'M_Constant', pairs: [{ source: 'TypeID', target: 'ConstantID' }], role: 'Loại khách hàng', display: 'ConstantName' },
    { id: 'r-gender', fromTable: 'M_Employee', toTable: 'M_Constant', pairs: [{ source: 'GenderID', target: 'ConstantID' }], role: 'Giới tính', display: 'ConstantName' },
    { id: 'r-dept', fromTable: 'M_Employee', toTable: 'M_Master', pairs: [{ source: 'DepartmentID', target: 'MasterID' }], role: 'Phòng ban', display: 'Name' }
  ]
};
const question = 'Tiền điện trên hóa đơn của KA0021 trong 2024-02 là bao nhiêu?';

test('filtered aggregate joins the customer lookup and binds the month as a half-open range', () => {
  const result = compile({ root: 'T_ElectricityOutput', operation: 'aggregate',
    measures: [{ ref: 'T_ElectricityOutput.FinalTotalAmount', aggregation: 'SUM' }],
    filters: [{ ref: 'M_Customer.CustomerCode', operator: 'eq', value: 'KA0021', evidence: 'KA0021' },
      { ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-02', evidence: '2024-02' }] }, catalog, { question });
  assert.match(result.sql, /LEFT JOIN \[dbo\]\.\[M_Customer\] t1 ON t1\.\[CustomerID\] = t0\.\[CustomerID\]/);
  assert.match(result.sql, /t1\.\[CustomerCode\] = N'KA0021'/);
  assert.match(result.sql, /t0\.\[ElectricityOutputDate\] >= '2024-02-01' AND t0\.\[ElectricityOutputDate\] < '2024-03-01'/);
  assert.match(result.sql, /SUM\(t0\.\[FinalTotalAmount\]\) AS \[Tổng Tiền sau thuế\]/);
  assert.ok(!/TOP/.test(result.sql));
  assert.deepEqual(result.scope, ['Mã khách hàng = KA0021', 'Ngày chứng từ: 01/02/2024 – trước 01/03/2024']);
});

test('lookups disambiguate roles; display columns replace mapped foreign keys', () => {
  const list = compile({ root: 'M_Employee', operation: 'list', fields: ['M_Employee.EmployeeCode', 'M_Employee.GenderID', 'M_Employee.DepartmentID'],
    filters: [{ ref: 'M_Employee.DepartmentID->Name', operator: 'eq', value: 'CSKH', evidence: 'phòng CSKH' }] }, catalog, { question: 'Nhân viên nào thuộc phòng CSKH, kèm giới tính' });
  assert.match(list.sql, /t\d\.\[ConstantName\] AS \[Giới tính\]/);
  // The department lookup joined for the filter is reused for the display column.
  const dept = /(t\d)\.\[Name\] AS \[Phòng ban\]/.exec(list.sql)[1];
  assert.ok(list.sql.includes(`WHERE ${dept}.[Name] = N'CSKH'`));
  assert.equal((list.sql.match(/M_Master/g) || []).length, 1);
  // Two roles reach M_Constant from the root's lookups only through named keys.
  assert.throws(() => compile({ root: 'T_ElectricityOutput', operation: 'list', fields: ['M_Constant.ConstantName'] }, catalog, { question: 'x' }), /V2_LOOKUP_AMBIGUOUS/);
  const period = compile({ root: 'T_ElectricityOutput', operation: 'list', fields: ['T_ElectricityOutput.CustomerID'],
    filters: [{ ref: 'T_ElectricityOutput.PeriodID->Name', operator: 'eq', value: 'Kỳ 3', evidence: 'Kỳ 3' }] }, catalog, { question: 'Hóa đơn điện Kỳ 3 gồm những khách hàng nào?' });
  assert.match(period.sql, /\[CustomerName\] AS \[Khách hàng\]/);
  assert.match(period.sql, /\[Name\] = N'Kỳ 3'/);
});

test('grouping, counting, ranking and monthly series compile and self-check', () => {
  const byMonth = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', analysis: 'anomaly',
    groupBy: [{ ref: 'T_ElectricityOutput.ElectricityOutputDate', grain: 'month' }], measures: [{ ref: 'T_ElectricityOutput.TotalQty', aggregation: 'SUM' }] }, catalog, { question: 'q' });
  assert.match(byMonth.sql, /DATEFROMPARTS\(YEAR\(t0\.\[ElectricityOutputDate\]\), MONTH\(t0\.\[ElectricityOutputDate\]\), 1\) AS \[Tháng\]/);
  assert.match(byMonth.sql, /ORDER BY DATEFROMPARTS/);
  const top = compile({ root: 'T_ElectricityOutput', operation: 'aggregate', groupBy: [{ ref: 'T_ElectricityOutput.CustomerID' }],
    measures: [{ ref: 'T_ElectricityOutput.FinalTotalAmount', aggregation: 'SUM' }], sort: { by: 'measure:0', direction: 'DESC' }, limit: 1 }, catalog, { question: 'q' });
  assert.match(top.sql, /^SELECT TOP 1 t1\.\[CustomerName\] AS \[Khách hàng\]/);
  assert.match(top.sql, /ORDER BY \[Tổng Tiền sau thuế\] DESC$/);
  const count = compile({ root: 'M_Employee', operation: 'aggregate', measures: [{ ref: '*', aggregation: 'COUNT' }],
    filters: [{ ref: 'M_Employee.GenderID->ConstantName', operator: 'eq', value: 'Nữ', evidence: 'nữ' }] }, catalog, { question: 'Có bao nhiêu nhân viên nữ?' });
  assert.match(count.sql, /COUNT\(\*\) AS \[Số bản ghi\]/);
});

test('ungrounded values, text on numeric keys and lookup sums are rejected before SQL exists', () => {
  const base = { root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ ref: 'T_ElectricityOutput.FinalTotalAmount', aggregation: 'SUM' }] };
  assert.throws(() => compile({ ...base, filters: [{ ref: 'M_Customer.CustomerCode', value: 'DC6011', evidence: 'DC6011' }] }, catalog, { question }), /V2_FILTER_UNGROUNDED/);
  assert.throws(() => compile({ ...base, filters: [{ ref: 'T_ElectricityOutput.CustomerID', value: 'KA0021', evidence: 'KA0021' }] }, catalog, { question }), /V2_FILTER_TYPE/);
  assert.throws(() => compile({ ...base, measures: [{ ref: 'M_Customer.CustomerID', aggregation: 'SUM' }] }, catalog, { question }), /V2_MEASURE_GRAIN/);
  assert.throws(() => compile({ ...base, filters: [{ ref: 'M_Customer.Secret', value: 'x', evidence: 'KA0021' }] }, catalog, { question }), /V2_COLUMN_UNKNOWN/);
  // A follow-up may carry a filter quoted from the previous question.
  const carried = compile({ ...base, filters: [{ ref: 'M_Customer.CustomerCode', value: 'KA0021', evidence: 'KA0021', inherited: true },
    { ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-01', evidence: '2024-01' }] }, catalog,
    { question: 'Còn tháng 2024-01 thì sao?', previousQuestion: question });
  assert.match(carried.sql, /N'KA0021'/);
});

test('catalog description annotates foreign keys with lookup role and display column', () => {
  const text = describe(catalog);
  assert.match(text, /PeriodID int -> M_Master \[Kỳ\] shows Name/);
  assert.match(text, /TABLE M_Employee \(default list: EmployeeCode, EmployeeName\)/);
});

test('transaction lists show the business date and main labeled amount', () => {
  const invoices = catalog.tables.get('t_electricityoutput');
  const withMoney = { ...catalog, tables: new Map([...catalog.tables, ['t_electricityoutput', { ...invoices, money: ['PowerMoney', 'FinalTotalAmount'], dateColumn: 'ElectricityOutputDate',
    columns: new Map([...invoices.columns, ['powermoney', { name: 'PowerMoney', type: 'float', label: '', pk: false }]]) }]]) };
  const defaults = compile({ root: 'T_ElectricityOutput', operation: 'list' }, withMoney, { question: 'Liệt kê hóa đơn điện' });
  assert.match(defaults.sql, /\[ElectricityOutputDate\] AS \[Ngày chứng từ\], t0\.\[FinalTotalAmount\] AS \[Tiền sau thuế\]/);
  const chosen = compile({ root: 'T_ElectricityOutput', operation: 'list', fields: ['T_ElectricityOutput.ElectricityOutputID'] }, withMoney, { question: 'q' });
  assert.match(chosen.sql, /\[FinalTotalAmount\] AS \[Tiền sau thuế\]/);
  // An unlabeled money column is never picked as the main amount.
  assert.ok(!/PowerMoney/.test(defaults.sql));
});

test('row references are grounded by a value the user saw, not by the question text', () => {
  const contract = { root: 'M_Employee', operation: 'list', fields: ['M_Employee.EmployeeName'],
    filters: [{ ref: 'M_Employee.EmployeeCode', operator: 'eq', value: 'NV003', evidence: 'Người thứ 2', fromResult: true }] };
  const question = 'Người thứ 2 trong danh sách trên tên là gì?';
  assert.match(compile(contract, catalog, { question, resultValues: new Set(['nv002', 'nv003']) }).sql, /\[EmployeeCode\] = N'NV003'/);
  // A value the previous result never showed is invented, and is rejected.
  assert.throws(() => compile(contract, catalog, { question, resultValues: new Set(['nv002']) }), /V2_FILTER_UNGROUNDED/);
  // The referring words must still come from the current question.
  assert.throws(() => compile({ ...contract, filters: [{ ...contract.filters[0], evidence: 'NV003' }] }, catalog,
    { question, resultValues: new Set(['nv003']) }), /V2_FILTER_UNGROUNDED/);
});

test('a flag filter is grounded by its quoted phrase and only accepts true or false', () => {
  const question = 'Những khách hàng nào là khách hàng hiện hữu?';
  const active = compile({ root: 'M_Customer', operation: 'list', fields: ['M_Customer.CustomerCode'],
    filters: [{ ref: 'M_Customer.IsActive', operator: 'eq', value: true, evidence: 'khách hàng hiện hữu' }] }, catalog, { question });
  assert.match(active.sql, /t0\.\[IsActive\] = 1/);
  assert.deepEqual(active.scope, ['Đang hoạt động: có ("khách hàng hiện hữu")']);
  const inactive = compile({ root: 'M_Customer', operation: 'list', fields: ['M_Customer.CustomerCode'],
    filters: [{ ref: 'M_Customer.IsActive', operator: 'eq', value: 0, evidence: 'hiện hữu' }] }, catalog, { question });
  assert.match(inactive.sql, /\(t0\.\[IsActive\] = 0 OR t0\.\[IsActive\] IS NULL\)/);
  assert.throws(() => compile({ root: 'M_Customer', operation: 'list', fields: ['M_Customer.CustomerCode'],
    filters: [{ ref: 'M_Customer.IsActive', operator: 'eq', value: 'có', evidence: 'hiện hữu' }] }, catalog, { question }), /V2_FILTER_TYPE/);
  assert.throws(() => compile({ root: 'M_Customer', operation: 'list', fields: ['M_Customer.CustomerCode'],
    filters: [{ ref: 'M_Customer.IsActive', operator: 'eq', value: 1, evidence: 'đang dùng' }] }, catalog, { question }), /V2_FILTER_UNGROUNDED/);
});
