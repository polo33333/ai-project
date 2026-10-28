'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('missing contract fields stay in administrative diagnostics and outside reply text', async () => {
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const BaseTool = require('../src/backend/agent/tools/base_tool');
  const manager = new (require('../src/backend/agent/tools/tool_manager'))();
  const search = new BaseTool({ name: 'search_schema', description: 'Schema', parameters: { type: 'object', properties: { query: { type: 'string' } } } });
  search.run = async () => ({ mode: 'data', selectedTables: ['records'], tables: [{ tableName: 'records', columns: [{ name: 'InternalTechnicalField', description: 'A required field' }] }] });
  manager.registerTool(search);
  let calls = 0;
  const harness = new Harness({ toolManager: manager, maxIterations: 2, maxRepairs: 0, dispatch: async () => ++calls === 1
    ? { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: '{"query":"records"}' } }] }
    : { content: 'Không lấy được kết quả.' } });
  const result = await harness.run({ userMessage: 'list records', provider: { id: 'fixture', supportsToolCalling: true }, context: {
    governedController: true, lockProvider: true, requestPlan: { table: 'records', intent: 'list', outputs: { data: true }, conversationState: { operation: 'list' } }
  } });
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.ok(!result.replyText.includes('InternalTechnicalField'));
  assert.ok(!result.replyText.includes('Chưa truy vấn đủ tiêu chí'));
  assert.ok(!result.replyText.includes('Một số tiêu chí yêu cầu'));
  const diagnostics = require('../src/backend/utils/chat_diagnostics').buildChatDiagnostics(result.trace);
  assert.equal(diagnostics.contractAssessment.complete, false);
  assert.equal(diagnostics.contractAssessment.fields[0].name, 'InternalTechnicalField');
  assert.equal(diagnostics.contractAssessment.fields[0].status, 'not_queried');
});


test('partial SQL evidence keeps completion failures in diagnostics without a chat warning', async () => {
  const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
  const BaseTool=require('../src/backend/agent/tools/base_tool');
  const manager=new (require('../src/backend/agent/tools/tool_manager'))();
  const add=(name,run)=>{const tool=new BaseTool({name,description:name,parameters:{type:'object',properties:{sql:{type:'string'},query:{type:'string'}}}});tool.run=run;manager.registerTool(tool);};
  add('list_workflows',async()=>({workflows:[]}));
  add('search_schema',async()=>({mode:'data',selectedTables:['records'],tables:[{tableName:'records',columns:[{name:'code'},{name:'dob',description:'Ngày sinh'}]}]}));
  add('execute_sql_query',async args=>({sql:args.sql,rows:[{code:'A'}]}));
  const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const responses=[call('list_workflows',{}),call('search_schema',{query:'records'}),call('execute_sql_query',{sql:'SELECT code FROM records'})];
  const harness=new Harness({toolManager:manager,maxIterations:3,maxRepairs:0,dispatch:async()=>responses.shift()||{content:''}});
  const result=await harness.run({userMessage:'list records with date of birth',provider:{id:'offline',supportsToolCalling:true},context:{governedController:true,lockProvider:true,mode:'data',requestPlan:{table:'records',intent:'list',presentation:'table',outputs:{data:true},conversationState:{operation:'list',requestedAttributes:['Ngày sinh']}}}});
  assert.equal(result.trace.completionStatus,'PARTIAL');
  assert.match(result.replyText,/A/);
  assert.doesNotMatch(result.replyText,/Một phần yêu cầu chưa hoàn tất|phần hiển thị trên là kết quả đã xác minh/);
  const diagnostics=require('../src/backend/utils/chat_diagnostics').buildChatDiagnostics(result.trace);
  assert.equal(diagnostics.completionStatus,'PARTIAL');assert.ok(diagnostics.responseEvaluation.failures.length);
});
