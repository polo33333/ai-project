const test=require('node:test'),assert=require('node:assert/strict');
const {format}=require('../src/backend/agent_core/harness/money_display');
const {buildSqlRowsFallbackReply}=require('../src/backend/agent_core/harness/grounded_reply');
test('money values use Vietnamese separators and only a known currency',()=>{
  assert.equal(format(6652704,'Tiền hóa đơn (VNĐ)'), '6.652.704 ₫');
  assert.equal(format('-1234.56','Amount','USD'), '-1.234,56 US$');
  assert.equal(format('0','Số dư công nợ (VNĐ)'), '0 ₫');
  assert.equal(format(1234.56,'Price'), '1.234,56');
  for(const value of [null,'','KA0021','6.652.704 ₫'])assert.equal(format(value,'Tiền (VNĐ)'),value);
  assert.equal(format('001234','EmployeeID'),'001234');
  assert.equal(format(2024,'Năm'),2024);
  assert.equal(format(246,'ContractID ID hợp đồng'),246);
  assert.equal(format(1500000,'ContractValue Giá trị hợp đồng'),'1.500.000');
  assert.equal(format(1500000,'Thành tiền (đồng)'),'1.500.000 ₫');
});
test('grounded answers format currency consistently in prose, tables and comparisons without mutating evidence',()=>{
  const result={rows:[{FinalTotalAmount:6652704,EmployeeID:1234}],displayNames:{FinalTotalAmount:'Tiền hóa đơn (VNĐ)'}};
  const call={result};
  for(const options of [{},{forceTable:true},{forceTable:true,comparison:true}]) {
    const reply=buildSqlRowsFallbackReply(call,{},options);
    assert.match(reply,/6\.652\.704 ₫/);
    assert.match(reply,/1234/);
  }
  assert.equal(result.rows[0].FinalTotalAmount,6652704);
});
