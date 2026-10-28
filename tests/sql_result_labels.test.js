'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inferDisplayNames}=require('../src/backend/services/sql_result_labels');
const {buildSqlRowsFallbackReply}=require('../src/backend/agent/harness/grounded_reply');
const tables=[
 {tableId:'employee',tableName:'Employee',columns:[{columnName:'Code',displayName:'Mã nhân viên'},{columnName:'GenderID'},{columnName:'DepartmentID'}]},
 {tableId:'lookup',tableName:'Lookup',columns:[{columnName:'ID'},{columnName:'Name',displayName:'Tên danh mục'}]}
];
const relationships=['Gender','Department'].map((name,i)=>({status:'verified',sourceTableId:'employee',targetTableId:'lookup',columnPairs:[{sourceColumn:name+'ID',targetColumn:'ID'}],displayColumn:'Name',businessRole:['Giới tính','Phòng ban'][i]}));
const sql='SELECT e.Code, g.Name AS Gender, d.Name AS Department FROM Employee e LEFT JOIN Lookup g ON e.GenderID=g.ID LEFT JOIN Lookup d ON e.DepartmentID=d.ID';
test('labels follow actual join aliases and configured roles, including repeated lookup tables',()=>{
 const displayNames=inferDisplayNames(sql,tables,relationships);
 assert.deepEqual(displayNames,{Code:'Mã nhân viên',Gender:'Giới tính',Department:'Phòng ban'});
 const rows=[{Code:'NV01',Gender:'Nam',Department:'Kỹ thuật'}];
 const reply=buildSqlRowsFallbackReply({result:{rows,displayNames}},{Gender:'Tên danh mục'},{forceTable:true});
 assert.match(reply,/Mã nhân viên \| Giới tính \| Phòng ban/);
 assert.match(reply,/NV01 \| Nam \| Kỹ thuật/);
 assert.deepEqual(rows,[{Code:'NV01',Gender:'Nam',Department:'Kỹ thuật'}]);
});
test('unverified or unproven joins never supply role labels',()=>{
 assert.equal(inferDisplayNames(sql,tables,relationships.map(r=>({...r,status:'suggested'}))).Gender,'Tên danh mục');
 assert.equal(inferDisplayNames(sql.replace('e.GenderID=g.ID','e.GenderID=g.ID OR 1=1'),tables,relationships).Gender,'Tên danh mục');
 assert.deepEqual(inferDisplayNames('SELECT Name FROM Lookup',tables,relationships),{Name:'Tên danh mục'});
});
test('ambiguous output keys, expressions and unknown lineage are not relabeled',()=>{
 const duplicate=sql.replace('g.Name AS Gender, d.Name AS Department','g.Name, d.Name');
 assert.deepEqual(inferDisplayNames(duplicate,tables,relationships),{Code:'Mã nhân viên'});
 assert.deepEqual(inferDisplayNames('SELECT COUNT(*) AS Name FROM Lookup',tables,relationships),{});
 assert.deepEqual(inferDisplayNames('SELECT Name FROM (SELECT Name FROM Lookup) x',tables,relationships),{});
});

test('an unnamed SQL Server aggregate retains its proven metric label and numeric zero', () => {
 const schema=[{tableName:'Invoices',columns:[{columnName:'ClosingBalance',displayName:'Số dư Nợ cuối kỳ'}]}];
 const displayNames=inferDisplayNames('SELECT SUM(i.ClosingBalance) FROM Invoices i',schema);
 assert.deepEqual(displayNames,{'':'Tổng Số dư Nợ cuối kỳ'});
 const rows=[{'':0}];
 const reply=buildSqlRowsFallbackReply({result:{rows,displayNames}});
 assert.ok(reply.includes('**Tổng Số dư Nợ cuối kỳ:** 0'));
 assert.ok(!reply.includes('**—'));
 assert.deepEqual(rows,[{'':0}]);
 assert.deepEqual(inferDisplayNames('SELECT SUM(i.ClosingBalance), MAX(i.ClosingBalance) FROM Invoices i',schema),{});
 assert.deepEqual(inferDisplayNames('SELECT SUM(i.ClosingBalance) FROM Invoices i',[{...schema[0],columns:[{...schema[0].columns[0],isVisible:false}]}]),{});
});

test('unresolved or placeholder result names never become a dash label', () => {
 for(const displayNames of [{},{'':'—'},{'':'   '}]) {
  const reply=buildSqlRowsFallbackReply({result:{rows:[{'':0}],displayNames}});
  assert.ok(reply.includes('**Giá trị kết quả 1:** 0'));
  assert.ok(!reply.includes('**—'));
 }
 const reply=buildSqlRowsFallbackReply({result:{rows:[{'':null}]}},{},{forceTable:true});
 assert.ok(reply.includes('| Giá trị kết quả 1 |'));
 assert.ok(reply.includes('| — |'));
});
