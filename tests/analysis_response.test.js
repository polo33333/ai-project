'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const analysis=require('../src/backend/agent_core/harness/analysis_response');
const {canFinalizeVerifiedRead}=require('../src/backend/agent_core/harness/completion_policy');
const source={toolName:'execute_sql_query',success:true,args:{sql:'SELECT YEAR(DocDate) AS Nam, MONTH(DocDate) AS Thang, SUM(Qty) AS TongSanLuong FROM Usage GROUP BY YEAR(DocDate), MONTH(DocDate)'},result:{rows:[{Nam:2024,Thang:2,TongSanLuong:3287},{Nam:2024,Thang:1,TongSanLuong:60192}]}};

test('an omitted analysis classification is explicitly resolved instead of silently becoming a plain aggregate',async()=>{
 let stage;
 assert.equal(await analysis.resolveTask(async(defs,messages,name)=>{stage=name;assert.equal(defs.length,0);assert.equal(messages.at(-1).content,'Find unusual months');return {content:'{"analysis":"anomaly"}'};},'Find unusual months'),'anomaly');
 assert.equal(stage,'analysis_task_resolution');
 await assert.rejects(analysis.resolveTask(async()=>({content:'{"operation":"aggregate"}'}),'Find unusual months'),/ANALYSIS_TASK_UNRESOLVED/);
});

test('analytical intent is not completed by returning an aggregate table',()=>{
 const plan={outputs:{data:true},conversationState:{operation:'aggregate',requestedAttributes:[]},schemaScope:{filters:[]}};
 assert.equal(canFinalizeVerifiedRead(plan,source),true);
 for(const analysisTask of ['anomaly','trend','forecast','analyze'])assert.equal(canFinalizeVerifiedRead({...plan,analysisTask},source),false);
 assert.equal(canFinalizeVerifiedRead({...plan,semanticIntent:{analysis:'anomaly'}},source),false);
});

test('two observed months explain change, criteria and missing baseline without declaring an anomaly',()=>{
 const reply=analysis.shortAnomalyReply(source,{analysisTask:'anomaly'});
 assert.match(reply,/Chưa đủ căn cứ/);
 assert.match(reply,/56\.905/);assert.match(reply,/94,54%/);
 assert.match(reply,/Tiêu chí/);assert.match(reply,/Giới hạn dữ liệu/);
 assert.ok(reply.indexOf('2024-01')<reply.indexOf('2024-02'));
 assert.match(reply,/không suy ra mức tiêu thụ thông thường/);
 assert.equal(source.result.rows[0].Thang,2,'rendering never mutates source rows');
});

test('unknown time lineage, multiple metrics and NULL cannot become anomaly evidence',()=>{
 assert.equal(analysis.shortAnomalyReply({...source,args:{sql:'SELECT A, B, SUM(Qty) AS TongSanLuong FROM Usage GROUP BY A,B'}},{analysisTask:'anomaly'}),null);
 assert.equal(analysis.shortAnomalyReply({...source,result:{rows:[{Nam:2024,Thang:1,TongSanLuong:null}]}},{analysisTask:'anomaly'}),null);
 assert.equal(analysis.shortAnomalyReply(source,{analysisTask:'trend'}),null);
 assert.equal(analysis.shortAnomalyReply({...source,result:{...source.result,hasMore:true}},{analysisTask:'anomaly'}),null);
});

test('zero baseline and nonadjacent months never produce a fabricated percentage or adjacent change',()=>{
 const reply=analysis.shortAnomalyReply({...source,result:{rows:[{Nam:2024,Thang:1,TongSanLuong:0},{Nam:2024,Thang:3,TongSanLuong:12}]}},{analysisTask:'anomaly'});
 assert.match(reply,/không tính phần trăm/);assert.match(reply,/không phải hai tháng liên tiếp/);
});

async function harnessCase(rows, finalText, requestIntent, searchFirst = false) {
 const Base=require('../src/backend/agent_core/tools/base_tool'),Manager=require('../src/backend/agent_core/tools/tool_manager'),Harness=require('../src/backend/agent_core/harness/guarded_agent_harness');
 const manager=new Manager();
 const register=(name,run)=>{const t=new Base({name,description:name,parameters:{type:'object',properties:{sql:{type:'string'},query:{type:'string'}}}});t.run=run;manager.registerTool(t);};
 register('list_workflows',async()=>({workflows:[]}));
 register('search_schema',async()=>({mode:'data',requestIntent,selectedTables:['Usage'],tables:[{tableName:'Usage',columns:[{name:'DocDate'},{name:'Qty'}]}]}));
 register('execute_sql_query',async args=>({sql:args.sql,rows}));
 const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const responses=[...(!searchFirst ? [call('list_workflows',{})] : []),call('search_schema',{query:'Usage'}),call('execute_sql_query',source.args),{content:finalText}];
 const result=await new Harness({toolManager:manager,dispatch:async()=>responses.shift()||{content:finalText}}).run({
  userMessage:'Find unusual monthly usage',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,mode:'data',requestPlan:{table:'Usage',intent:'aggregate',analysisTask:'anomaly',presentation:'table',schemaColumns:['DocDate','Qty'],outputs:{data:true},schemaScope:{filters:[]},conversationState:{operation:'aggregate',requestedAttributes:[]}}}});
 return {result,responses};
}

test('harness returns the short-series limitation immediately and does not overwrite it with a table',async()=>{
 const {result,responses}=await harnessCase(source.result.rows,'Unsupported claim of an anomaly');
 assert.match(result.replyText,/Chưa đủ căn cứ/);assert.match(result.replyText,/94,54%/);
 assert.equal(result.trace.completionStatus,'PARTIAL');
 assert.ok(result.trace.steps.some(s=>s.type==='ANALYSIS_INSUFFICIENT_HISTORY'));
 assert.ok(!result.trace.steps.some(s=>s.type==='VERIFIED_READ_COMPLETE'));
 assert.equal(responses.length,1,'No speculative model conclusion is needed for this insufficient-history response');
});

test('harness retains the analytical answer instead of replacing it with raw rows',async()=>{
 const answer='Tiêu chí: chưa có ngưỡng được duyệt. Kết luận: chỉ đối chiếu các mốc quan sát, không xác nhận bất thường. Giới hạn: chưa đủ lịch sử.';
 const {result}=await harnessCase([...source.result.rows,{Nam:2024,Thang:3,TongSanLuong:4500}],answer);
 assert.equal(result.replyText,answer);
 assert.ok(!result.trace.steps.some(s=>s.type==='GROUNDED_RESULT_RENDER'));
});

test('a describe classification after schema search cannot stop an authorized analytical read',async()=>{
 for(const operation of ['describe','guidance']) {
  const {result}=await harnessCase(source.result.rows,'Only explains schema',{operation,attributes:[],presentation:'text'});
  assert.ok(result.toolCalls.some(call=>call.toolName==='execute_sql_query'&&call.success));
  assert.match(result.replyText,/Chưa đủ căn cứ/);
  assert.ok(!result.trace.steps.some(step=>step.type==='VERIFIED_SCHEMA_DESCRIPTION'));
 }
});

test('verified zero rows stop analytical repair loops and report the actual evidence gap',async()=>{
 const {result,responses}=await harnessCase([],'Chưa thể hoàn tất yêu cầu. Vui lòng thử lại.');
 assert.match(result.replyText,/Truy vấn đã thực hiện thành công/);
 assert.match(result.replyText,/không tìm thấy bản ghi/);
 assert.match(result.replyText,/không tự chuyển sang khoảng khác/);
 assert.ok(!result.replyText.includes('Vui lòng thử lại'));
 assert.equal(result.trace.completionStatus,'PARTIAL');
 assert.ok(result.trace.steps.some(step=>step.type==='ANALYSIS_NO_MATCHING_DATA'));
 assert.equal(result.toolCalls.filter(call=>call.toolName==='execute_sql_query').length,1);
 assert.equal(responses.length,1);
});

test('failed reads, unverified emptiness and zero consumption are distinct from no matching rows',()=>{
 assert.equal(analysis.emptyReply({...source,success:false,result:{rows:[]}}, {analysisTask:'anomaly'}),null);
 assert.equal(analysis.emptyReply({...source,result:{rows:[],truncated:true}}, {analysisTask:'anomaly'}),null);
 assert.equal(analysis.emptyReply({...source,result:{rows:[{Nam:2024,Thang:1,TongSanLuong:0}]}}, {analysisTask:'anomaly'}),null);
 assert.equal(analysis.emptyReply({...source,result:{rows:[]}}, {}),null);
});

test('analysis completes mandatory catalog discovery before SQL without model repair rounds',async()=>{
 const {result}=await harnessCase([],'Unused conclusion',undefined,true);
 assert.ok(result.trace.steps.some(step=>step.type==='ANALYSIS_CATALOG_DISCOVERY'));
 assert.ok(!result.trace.steps.some(step=>step.type==='WORKFLOW_DISCOVERY_REQUIRED'));
 assert.match(result.replyText,/không tìm thấy bản ghi/);
 assert.equal(result.trace.executionBudget.repairAttempts,0);
});
