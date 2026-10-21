'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessCalculation}=require('../src/backend/agent_core/harness/calculation_scope');
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
test('guarded calculator never executes an expression rejected for source conflict',async t=>{
  const Harness=require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager=require('../src/backend/agent_core').defaultToolManager;
  let executed=0;t.mock.method(manager.getTool('calculate_expression'),'run',async()=>{executed++;return {value:220}});
  const harness=new Harness({toolManager:manager,dispatch:async(provider,messages,defs)=>defs.some(d=>d.function?.name==='assess_calculation')
    ? {tool_calls:[{id:'review',type:'function',function:{name:'assess_calculation',arguments:'{"allowed":false,"answer":"The two sources differ by 20 million. The correct payable amount requires reconciliation."}'}}]}
    : {tool_calls:[{id:'calc',type:'function',function:{name:'calculate_expression',arguments:'{"expression":"100+120"}'}}]}});
  const result=await harness.run({userMessage:'Contract says 100 million, same-period invoice 120 million. What amount is correct?',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['calculate_expression'],context:{governedController:true,lockProvider:true,mode:'general'}});
  assert.equal(executed,0);assert.match(result.replyText,/reconciliation/);assert.doesNotMatch(result.replyText,/220/);
  assert.ok(result.trace.steps.some(s=>s.type==='CALCULATION_SCOPE_CONFLICT'));
});
