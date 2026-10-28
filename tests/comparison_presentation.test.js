'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSqlRowsFallbackReply } = require('../src/backend/agent/harness/grounded_reply');

test('verified age superlatives answer directly, disclose missing-date scope and flag suspect employee dates',()=> {
 const sql='SELECT verified ranking';
 const ranking={sql,kind:'youngest',subject:'employee',column:'BirthDate',identityColumns:['Name','Code']};
 const call={args:{sql},result:{ranking,rows:[{Code:'NV007',Name:'Nguyễn Văn B',BirthDate:'2024-05-24'}]}};
 const text=buildSqlRowsFallbackReply(call);
 assert.ok(text.startsWith('**Nguyễn Văn B · NV007** trẻ nhất'));
 assert.ok(text.includes('24/05/2024'));
 assert.ok(text.includes('Hồ sơ thiếu ngày sinh không được xét'));
 assert.ok(text.includes('Cần kiểm tra dữ liệu'));
 assert.ok(!text.includes('Thứ tự truy vấn'));
 const tied=buildSqlRowsFallbackReply({...call,result:{...call.result,rows:[{Name:'A',Code:'A',BirthDate:'2002-05-24'},{Name:'B',Code:'B',BirthDate:'2002-05-24'}]}});
 assert.ok(tied.includes('**A · A**, **B · B** đồng hạng trẻ nhất'));
 assert.ok(!tied.includes('Cần kiểm tra dữ liệu'));
 const oldest=buildSqlRowsFallbackReply({...call,result:{...call.result,ranking:{...ranking,kind:'oldest'}}});
 assert.ok(oldest.includes('lớn tuổi nhất'));
 // A stale ranking descriptor or rows with different dates cannot support a superlative.
 assert.ok(!buildSqlRowsFallbackReply({...call,args:{sql:'different SQL'}}).includes('trẻ nhất'));
 assert.ok(!buildSqlRowsFallbackReply({...call,result:{...call.result,rows:[...call.result.rows,{Name:'B',Code:'B',BirthDate:'2002-05-24'}]}}).includes('trẻ nhất'));
});
test('ordinary results explain their fields, ordering and missing values using executed data',()=> {
 const text=buildSqlRowsFallbackReply({args:{sql:'SELECT Code, BirthDate FROM People ORDER BY BirthDate DESC'},result:{rows:[{Code:'A',BirthDate:'2002-05-24'},{Code:'B',BirthDate:null}]}},
  {Code:'Mã',BirthDate:'Ngày sinh'},{forceTable:true});
 assert.match(text,/\*\*2\*\* bản ghi/);assert.ok(text.includes('**Ngày sinh giảm dần**'));
 assert.ok(text.includes('**Ngày sinh** (1/2 dòng)'));assert.ok(text.includes('| A | 24/05/2002 |'));
});

test('comparison transposes mapped verified rows into criteria and object columns', () => {
  const rows = [{ Code: 'A', Label: 'One', Department: 'Support', DOB: null },
    { Code: 'B', Label: 'Two', Department: 'Engineering', DOB: '2024-05-24' }];
  const reply = buildSqlRowsFallbackReply({ result: { rows } }, { Department: 'Team' }, { forceTable: true, comparison: true });
  assert.ok(reply.includes('| A | B |'));
  assert.ok(reply.includes('| Team | Support | Engineering |'));
  assert.ok(reply.includes('| DOB | — | 24/05/2024 |'));
  assert.ok(!reply.includes('| Code | Label |'));
});

test('ordinary table stays row-oriented and comparison escapes cell content', () => {
  const rows = [{ Code: 'A', Value: 'x|y\nz' }, { Code: 'B', Value: 'other' }];
  const regular = buildSqlRowsFallbackReply({ result: { rows } }, {}, { forceTable: true });
  assert.ok(regular.includes('| Code | Value |'));
  const comparison = buildSqlRowsFallbackReply({ result: { rows } }, {}, { forceTable: true, comparison: true });
  assert.ok(comparison.includes('x\\|y z'));
});

test('comparison prefers business identity over the leading numeric primary key', () => {
  const rows = [{ EmployeeID: 6, EmployeeCode: 'NV006', EmployeeName: 'One' },
    { EmployeeID: 10, EmployeeCode: 'NV007', EmployeeName: 'Two' }];
  const reply = buildSqlRowsFallbackReply({ result: { rows } }, {}, { forceTable: true, comparison: true });
  assert.equal(reply.split('\n')[0], '| Tiêu chí | NV006 | NV007 |');
  assert.ok(reply.includes('| EmployeeID | 6 | 10 |'));
});

test('comparison resolves configured display identities through SQL display aliases', () => {
  const rows = [{ id: 6, unrelated: 'x', 'Mã nhân viên': 'NV006' },
    { id: 10, unrelated: 'y', 'Mã nhân viên': 'NV007' }];
  const reply = buildSqlRowsFallbackReply({ result: { rows } }, { EmployeeCode: 'Mã nhân viên' },
    { forceTable: true, comparison: true, displayIdentityColumns: ['EmployeeCode'] });
  assert.equal(reply.split('\n')[0], '| Tiêu chí | NV006 | NV007 |');
});

test('duplicate display values fall back to unique numeric identity', () => {
  const rows = [{ id: 6, label: 'Same' }, { id: 10, label: 'Same' }];
  const reply = buildSqlRowsFallbackReply({ result: { rows } }, {}, { forceTable: true, comparison: true });
  assert.equal(reply.split('\n')[0], '| Tiêu chí | 6 | 10 |');
});

test('renderer retains later-row fields and distinguishes missing fields from NULL', () => {
  const reply = buildSqlRowsFallbackReply({ result: { rows: [{ code: 'A', value: null }, { code: 'B', value: null, later: 'x' }], hasMore: true } }, {}, { forceTable: true });
  assert.ok(reply.includes('| code | value | later |'));
  assert.ok(reply.includes('| A | — | Chưa truy vấn |'));
  assert.ok(reply.includes('chưa bao phủ toàn bộ phạm vi'));
});

test('renderer discloses both row and field display limits', () => {
  const row = Object.fromEntries(Array.from({ length: 102 }, (_, index) => [`field${index}`, index]));
  const reply = buildSqlRowsFallbackReply({ result: { rows: Array.from({ length: 12 }, () => row) } }, {}, { forceTable: true });
  assert.ok(reply.includes('Hiển thị 10/12 kết quả'));
  assert.ok(reply.includes('Hiển thị 100/102 trường'));
});
