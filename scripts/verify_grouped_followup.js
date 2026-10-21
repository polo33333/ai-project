'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const storage=require('../src/backend/storage');
storage.loadEnvironment();
async function main(){
 await storage.bootstrapStorage();
 try{await storage.run(async()=>{
  const logs=require('../src/backend/services/logger_service').chatHistory;
  const grouped=logs.find(x=>x.id==='2358819a-9fc9-4f16-b13d-e061dc9d0e1b');
  const complaint=logs.find(x=>x.id==='efb5ab38-3a38-449b-8f43-44fa0719b2fe');
  assert.ok(grouped&&complaint);
  const provider=require('../src/backend/services/ai_provider_manager').getProviderForExecution(grouped.requestPayload.providerId);
  const adapter=require('../src/backend/intelligent_core/adapters');
  const dispatch=(defs,messages)=>adapter.dispatchToProvider({...provider,temperature:0.1},messages,defs,AbortSignal.timeout(45000));
  const candidates=[{id:'dataset:latest',kind:'dataset',data:{table:'M_Employee',rowCount:9}}];
  const recent=[{role:'user',content:'hiển thị ds nv trên thêm cột giới tính và phòng ban'},{role:'assistant',content:'Danh sách nhân viên có các cột Mã nhân viên, Tên nhân viên, Giới tính, Phòng ban. Giá trị giới tính trong kết quả: Nam, Nữ.'}];
  const resolution=await require('../src/backend/memory_core/conversation_resolver').resolve(dispatch,grouped.question,{candidates,recent});
  assert.equal(resolution.operation,'list');assert.ok(resolution.resultGroupBy?.length);
  const evidence=Object.values(grouped.requestPayload.evidencePayloads).find(e=>e.rows);
  const call={result:evidence};
  const groups=require('../src/backend/agent_core/harness/result_grouping').partition(call,resolution.resultGroupBy);
  assert.ok(groups);assert.deepEqual(groups.map(g=>g.rows.length).sort((a,b)=>a-b),[2,7]);
  const rendered=require('../src/backend/agent_core/harness/grounded_reply').buildSqlRowsFallbackReply(call,{}, {resultGroupBy:resolution.resultGroupBy});
  const Harness=require('../src/backend/agent_core/harness/guarded_agent_harness');
  const result=await new Harness({toolManager:{getToolDefinitions:()=>[]},dispatch:(p,m,d)=>adapter.dispatchToProvider(p,m,d,AbortSignal.timeout(45000))}).run({userMessage:complaint.question,provider,
    context:{governedController:true,lockProvider:true,mode:'general',requestPlan:{outputs:{data:false}},resolutionContext:{candidates,recent:[{role:'user',content:grouped.question},{role:'assistant',content:grouped.replyText}]}}});
  console.log(JSON.stringify({feedback:result.replyText,steps:result.trace.steps.filter(s=>['MEMORY_RESOLVED','MEMORY_RESOLUTION_UNAVAILABLE','MEMORY_RESOLUTION_REJECTED'].includes(s.type))}));
  assert.ok(result.trace.steps.some(s=>s.type==='ANSWER_FEEDBACK_EXPLAINED'));
  assert.equal(result.toolCalls.length,0);assert.equal(result.trace.completionStatus,'SUCCESS');
  assert.doesNotMatch(result.replyText,/M_Price|TypeID/);
  const report={resolution,groups:groups.map(g=>({values:g.values,count:g.rows.length})),rendered,feedback:result.replyText,feedbackStatus:result.trace.completionStatus};
  fs.mkdirSync('artifacts/grouped-followup',{recursive:true});fs.writeFileSync('artifacts/grouped-followup/verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({operation:resolution.operation,resultGroupBy:resolution.resultGroupBy,groups:report.groups,feedback:result.replyText,status:result.trace.completionStatus}));
 });}finally{await storage.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
