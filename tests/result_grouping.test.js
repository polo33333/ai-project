'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {partition}=require('../src/backend/agent/harness/result_grouping');
const {buildSqlRowsFallbackReply}=require('../src/backend/agent/harness/grounded_reply');
test('conversational feedback referencing historical output never requires fresh business data',()=>{
 const resolver=require('../src/backend/memory/conversation_resolver');
 const value=resolver.decode({content:JSON.stringify({relation:'followup',operation:'conversation',cardinality:'none',attributes:[],selectedIds:['d'],clarification:'',dataUse:'historical'})},[{id:'d',kind:'dataset',data:{table:'Employees'}}]);
 assert.equal(value.dataUse,'none');
});
test('separate categorical lists retain every row and use configured mapped labels',()=>{
 const rows=[{Code:'A',Gender:'Nam'},{Code:'B',Gender:'Nữ'},{Code:'C',Gender:'Nam'}];
 const call={result:{rows,displayNames:{Gender:'Giới tính',Code:'Mã nhân viên'}}};
 const reply=buildSqlRowsFallbackReply(call,{}, {resultGroupBy:['Giới tính']});
 assert.match(reply,/\*\*Nam \(2\)\*\*/);assert.match(reply,/\*\*Nữ \(1\)\*\*/);
 const [male,female]=reply.split('**Nữ (1)**');
 assert.match(male,/\| A \|/);assert.match(male,/\| C \|/);assert.doesNotMatch(male,/\| B \|/);
 assert.match(female,/\| B \|/);assert.equal(rows.length,3);
 assert.doesNotMatch(buildSqlRowsFallbackReply(call),/\*\*Nam \(2\)\*\*/);
});
test('missing and ambiguous grouping fields fail closed; nulls and partial coverage remain explicit',()=>{
 assert.equal(partition({result:{rows:[{Name:'A'}]}},['Gender']),null);
 assert.equal(partition({result:{rows:[{a:1,b:2}],displayNames:{a:'Group',b:'Group'}}},['Group']),null);
 const reply=buildSqlRowsFallbackReply({result:{rows:[{Gender:null,Name:'A'}],hasMore:true}},{},{resultGroupBy:['Gender']});
 assert.match(reply,/Chưa xác định/);assert.match(reply,/chưa bao phủ toàn bộ/);
});
test('answer complaint stays on prior transcript and executes no schema or data tools',async()=>{
 const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
 let calls=0;
 const harness=new Harness({toolManager:{getToolDefinitions:()=>[]},dispatch:async(provider,messages,defs)=>{
  calls++;
  if(defs[0]?.function.name==='resolve_conversation')return {content:JSON.stringify({relation:'followup',operation:'conversation',cardinality:'none',attributes:[],selectedIds:['dataset:latest'],clarification:'',dataUse:'none',sourceScope:'enterprise'})};
  assert.equal(defs.length,0);
  const data=JSON.parse(messages.at(-1).content);
  assert.equal(data.references[0].table,'M_Employee');assert.match(data.recent[0].content,/giới tính/);
  assert.match(data.recent[1].content,/Nam/);
  return {content:'Bạn yêu cầu tách hai nhóm, nhưng tôi đã trả một bảng chung. Đó là thiếu sót trong cách trình bày.'};
 }});
 const value=await harness.run({userMessage:'t ko thấy phân loại tách biệt',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,mode:'general',requestPlan:{intent:'list',outputs:{data:true}},resolutionContext:{candidates:[{id:'dataset:latest',kind:'dataset',data:{table:'M_Employee',rowCount:3}}],recent:[{role:'user',content:'phân loại theo giới tính gửi cho tôi ds 2 loại trên'},{role:'assistant',content:'| A | Nam |\n| B | Nữ |'}]}}});
 assert.equal(calls,2);assert.deepEqual(value.toolCalls,[]);assert.match(value.replyText,/hai nhóm/);
 assert.equal(value.trace.completionStatus,'SUCCESS');
});
