'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessCalculation}=require('../src/backend/agent/harness/calculation_scope');
test('conflicting sources are blocked while independent arithmetic can proceed',async()=>{
  const reply=value=>async()=>({tool_calls:[{id:'review',type:'function',function:{name:'assess_calculation',arguments:JSON.stringify(value)}}]});
  const blocked=await assessCalculation(reply({allowed:false,answer:'Two sources disagree; reconcile before deciding the amount.'}),'Contract and same-period invoice disagree',{expression:'100+120'});
  assert.equal(blocked.allowed,false);
  assert.equal((await assessCalculation(reply({allowed:true,answer:''}),'Add two separate purchases',{expression:'100+120'})).allowed,true);
});
test('malformed or empty conflict assessments fail closed',async()=>{
  await assert.rejects(()=>assessCalculation(async()=>({content:'not JSON'}),'question',{expression:'100+120'}),{code:'CALCULATION_ASSESSMENT_INVALID'});
  await assert.rejects(()=>assessCalculation(async()=>({content:'{"allowed":false,"answer":""}'}),'question',{expression:'100+120'}),{code:'CALCULATION_ASSESSMENT_INVALID'});
});

test('calculation review receives already verified source rows and incomplete-preview status',async()=>{
 const evidence=[{sql:'SELECT Period, Amount FROM Records',dbSourceId:'allowed',rows:[{Period:'A',Amount:100},{Period:'B',Amount:80}],previewOnly:false}];
 let request;
 await assessCalculation(async(defs,messages)=>{request=JSON.parse(messages.at(-1).content);return {content:'{"allowed":true,"answer":""}'};},'Compare B with A',{expression:'80-100'},evidence);
 assert.deepEqual(request.evidence,evidence);
});

test('an unverified data calculation cannot pass completion merely because SQL rows exist',()=>{
 const {evaluateCompletion}=require('../src/backend/agent/harness/completion_policy');
 const plan={table:'Records',outputs:{data:true},calculationUnverified:true};
 const result=evaluateCompletion({reply:'Please provide the values again.',plan,toolCalls:[{toolName:'execute_sql_query',success:true,result:{sql:'SELECT Amount FROM Records',rows:[{Amount:100}]}}]});
 assert.ok(result.failures.includes('CALCULATION_NOT_VERIFIED'));
 assert.equal(result.valid,false);
});
test('guarded calculator never executes an expression rejected for source conflict',async t=>{
  const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
  const manager=require('../src/backend/agent').defaultToolManager;
  let executed=0;t.mock.method(manager.getTool('calculate_expression'),'run',async()=>{executed++;return {value:220}});
  const harness=new Harness({toolManager:manager,dispatch:async(provider,messages,defs)=>defs.some(d=>d.function?.name==='assess_calculation')
    ? {tool_calls:[{id:'review',type:'function',function:{name:'assess_calculation',arguments:'{"allowed":false,"answer":"The two sources differ by 20 million. The correct payable amount requires reconciliation."}'}}]}
    : {tool_calls:[{id:'calc',type:'function',function:{name:'calculate_expression',arguments:'{"expression":"100+120"}'}}]}});
  const result=await harness.run({userMessage:'Contract says 100 million, same-period invoice 120 million. What amount is correct?',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['calculate_expression'],context:{governedController:true,lockProvider:true,mode:'general'}});
  assert.equal(executed,0);assert.match(result.replyText,/reconciliation/);assert.doesNotMatch(result.replyText,/220/);
  assert.ok(result.trace.steps.some(s=>s.type==='CALCULATION_SCOPE_CONFLICT'));
});
