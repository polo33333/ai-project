'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inputFields}=require('../src/backend/automation/sql_input_fields');
const suitability=require('../src/backend/memory_core/workflow_suitability');
const query=require('../src/backend/services/semantic_query');
const groups=require('../src/backend/agent_core/harness/semantic_groups');
const lookup={inputs:{query:{schema:{type:'string'}}},bindings:{lookup:{sql:"SELECT c.ContractNo FROM dbo.Contracts c JOIN dbo.Customers u ON c.CustomerID=u.CustomerID WHERE c.ContractNo LIKE CONCAT('%',@query,'%') OR u.CustomerName LIKE CONCAT('%',@query,'%')",parameters:{query:{slot:'query'}}}}};
test('lookup parameter fields come from WHERE predicates, not join keys or projected IDs',()=>{
 assert.deepEqual(inputFields(lookup),{query:[{table:'Contracts',column:'ContractNo'},{table:'Customers',column:'CustomerName'}]});
});
test('workflow cannot accept a customer code as a name or contract-number filter',async()=>{
 await assert.rejects(suitability.assess(async()=>({content:JSON.stringify({suitable:true,reason:'Same entity',confirmedSlots:['query'],inputBindings:[{slot:'query',table:'Customers',column:'CustomerCode'}]})}),
  'List all contracts for customer code C002',{operation:'list',proposedInputs:{query:'C002'}},lookup),{code:'WORKFLOW_INPUT_FIELD_MISMATCH'});
 const result=await suitability.assess(async()=>({content:JSON.stringify({suitable:true,reason:'Supported customer name',confirmedSlots:['query'],inputBindings:[{slot:'query',table:'Customers',column:'CustomerName'}]})}),
  'Contracts of customer Example Ltd',{operation:'list',proposedInputs:{query:'Example Ltd'}},lookup);
 assert.equal(result.suitable,true);
});
const table={tableName:'Contracts',isActive:true,columns:[{columnName:'ID',dataType:'int',isPrimaryKey:true},{columnName:'Expiry',dataType:'date'},{columnName:'Name',dataType:'nvarchar'}]};
const request=(operator,offsetDays)=>({table:'Contracts',operation:'list',fields:['ID','Expiry'],filters:[{column:'Expiry',operator,value:{anchorDate:'2026-10-19',offsetDays}}]});
test('day windows compute 30 days, validate dates and reject offsets on non-date fields',()=>{
 const sql=query.compile({...request('gte',0),filters:[...request('gte',0).filters,...request('lt',30).filters]},[table]).sql;
 assert(sql.includes("[Expiry] >= N'2026-10-19' AND [Expiry] < N'2026-11-18'"));
 const invalid=request('lt',30);invalid.filters[0].value.anchorDate='2023-02-29';
 assert.throws(()=>query.compile(invalid,[table]),{code:'SEMANTIC_DATE_FILTER_INVALID'});
 const text=request('lt',30);text.filters[0].column='Name';
 assert.throws(()=>query.compile(text,[table]),{code:'SEMANTIC_DATE_FILTER_INVALID'});
});
test('business codes cannot be compiled against numeric IDs and dates cannot use substring filters',()=>{
 assert.throws(()=>query.compile({table:'Contracts',operation:'list',fields:['ID'],filters:[{column:'ID',operator:'eq',value:'C002'}]},[table]),{code:'SEMANTIC_FILTER_TYPE'});
 assert.throws(()=>query.compile({table:'Contracts',operation:'list',fields:['ID'],filters:[{column:'Expiry',operator:'contains',value:'2024-02'}]},[table]),{code:'SEMANTIC_DATE_FILTER_INVALID'});
});
test('multi-group rendering preserves an empty upcoming set and nonempty expired set; missing queries are not empty',()=>{
 const planned=groups.prepare([{label:'Upcoming',query:request('gte',0)},{label:'Expired',query:request('lt',0)}]);
 const calls=[{semanticGroup:0,success:true,result:{rows:[]}},{semanticGroup:1,success:true,result:{rows:[{ID:7,Expiry:'2024-12-31'}]}}];
 const render=require('../src/backend/agent_core/harness/grounded_reply').buildSqlRowsFallbackReply;
 const reply=groups.render(planned,calls,render);
 assert(reply.includes('**Upcoming**'));assert(reply.includes('Không tìm thấy dữ liệu phù hợp.'));assert(reply.includes('**Expired**'));assert(reply.includes('31/12/2024'));
 const incomplete=groups.render(planned,calls.slice(0,1),render);
 assert(incomplete.includes('Chưa truy vấn được nhóm này'));
 assert.equal(groups.results(planned,calls).every(g=>g.call),true);
 assert.equal(groups.results(planned,calls.slice(0,1)).every(g=>g.call),false);
 calls[0].result.hasMore=true;
 assert.equal(groups.results(planned,calls).every(g=>g.complete),false,'A complete second group must not hide truncation in the first group');
 assert(groups.render(planned,calls,render).includes('chưa phải toàn bộ kết quả'));
});
