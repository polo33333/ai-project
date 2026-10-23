'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {disposition}=require('../src/backend/services/chat_retry_policy');
const fs=require('node:fs'),vm=require('node:vm');
test('only a verified analytical limitation is usable as a partial retry replacement',()=>{
 for(const type of ['ANALYSIS_INSUFFICIENT_HISTORY','ANALYSIS_NO_MATCHING_DATA']) {
  const r={success:true,replyText:'Verified data limitation',trace:{completionStatus:'PARTIAL',steps:[{type}]},toolCalls:[{toolName:'execute_sql_query',success:true,result:{rows:[]}}]};
  assert.equal(disposition(r),'verified_partial');
  assert.equal(disposition({...r,success:false}),null);
  assert.equal(disposition({...r,replyText:' '}),null);
  assert.equal(disposition({...r,trace:{...r.trace,steps:[]}}),null);
  assert.equal(disposition({...r,toolCalls:[{toolName:'search_schema',success:true,result:{rows:[]}}]}),null);
  assert.equal(disposition({...r,toolCalls:[{toolName:'execute_sql_query',success:false,result:{rows:[]}}]}),null);
 }
});

test('the API payload carries the verified-partial disposition to the retry button',()=>{
 const router=fs.readFileSync('src/backend/routes/router.js','utf8');
 const frontend=fs.readFileSync('src/frontend/js/modules/page_chat.js','utf8');
 const sandbox=vm.createContext({selectUserFacingSqlExecutions:executions=>executions||[],buildChatDiagnostics:()=>null,
  require:name=>name.endsWith('chat_retry_policy')?{disposition}:{createAnswerEnvelope:()=>({})}});
 vm.runInContext(router.slice(router.indexOf('function buildChatClientPayload('),router.indexOf('function parseCookies(')),sandbox);
 vm.runInContext(frontend.slice(frontend.indexOf('function isPageChatRetryResultUsable('),frontend.indexOf('async function retryPageChatAnswer(')),sandbox);
 const result={success:true,replyText:'Chưa đủ lịch sử để kết luận; đã đối chiếu các tháng có dữ liệu.',trace:{completionStatus:'PARTIAL',steps:[{type:'ANALYSIS_INSUFFICIENT_HISTORY'}]},toolCalls:[{toolName:'execute_sql_query',success:true,result:{rows:[{Qty:1}]}}]};
 const payload=sandbox.buildChatClientPayload(result,100,'audit');
 assert.equal(payload.retryDisposition,'verified_partial');
 assert.equal(sandbox.isPageChatRetryResultUsable(payload),true);
 const failed=sandbox.buildChatClientPayload({...result,trace:{completionStatus:'PARTIAL',steps:[]}},100,'failed-audit');
 assert.equal(sandbox.isPageChatRetryResultUsable(failed),false);
});

test('a grounded time-window clarification replaces a retry result without accepting failed SQL or other incomplete criteria',()=>{
 const r={success:true,replyText:'Three expired records; please specify the upcoming window.',
  toolCalls:[{toolName:'execute_sql_query',success:true,result:{rows:[{ID:1}]}}],
  trace:{completionStatus:'PARTIAL',steps:[],sqlEvidence:[{index:0,assessment:{accepted:true}}],
   training:{plan:{requestTime:{needsHorizon:true}},responseEvaluation:{failures:['TEMPORAL_HORIZON_REQUIRED']}}}};
 assert.equal(disposition(r),'verified_partial');
 assert.equal(disposition({...r,trace:{...r.trace,sqlEvidence:[{index:0,assessment:{accepted:false}}]}}),null);
 assert.equal(disposition({...r,trace:{...r.trace,training:{...r.trace.training,responseEvaluation:{failures:['TEMPORAL_HORIZON_REQUIRED','CONTRACT_FIELDS_NOT_QUERIED']}}}}),null);
});
