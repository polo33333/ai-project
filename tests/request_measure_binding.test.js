const test = require('node:test'), assert = require('node:assert/strict');
const { bind } = require('../src/backend/agent/harness/request_measures');
const { evaluateSql } = require('../src/backend/training/sql_evaluator');
const tables = [{tableName:'Invoices',columns:[{name:'Amount',type:'DECIMAL(18,2)'},{name:'Qty',type:'INT'},{name:'Secret',type:'MONEY',isVisible:false}]}];
test('reviewed measures supersede defaults only through visible authorized numeric fields', () => {
  const measures = bind([{table:'Invoices',column:'Amount',aggregation:'SUM'}], tables);
  const plan = {intent:'aggregate',metric:'Amount',aggregation:'SUM',requiredMeasures:measures};
  assert.equal(evaluateSql('SELECT SUM(i.Amount) AS Amount FROM Invoices i',plan).valid,true);
  assert.equal(evaluateSql('SELECT SUM(i.Qty) AS Amount FROM Invoices i',plan).valid,false);
  assert.equal(evaluateSql('SELECT SUM(x.Amount) FROM Other x',plan).valid,false);
  for (const column of ['Missing','Secret']) assert.throws(()=>bind([{table:'Invoices',column,aggregation:'SUM'}],tables),/REQUEST_MEASURE_UNAVAILABLE/);
  assert.equal(bind(undefined,tables),null);
});

test('harness uses reviewed aggregate measure instead of a stale table default', async t => {
  const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
  const Manager=require('../src/backend/agent/tools/tool_manager'),Base=require('../src/backend/agent/tools/base_tool');
  const raw={tableName:'Invoices',dbSourceId:'source',isActive:true,defaultMetric:'Qty',columns:[{columnName:'Amount',dataType:'DECIMAL(18,2)'},{columnName:'Qty',dataType:'INT'}]};
  t.mock.method(require('../src/backend/services/dictionary_service'),'getGroupedTables',()=>[raw]);
  const manager=new Manager(),executed=[];
  const register=(name,run)=>{const tool=new Base({name,description:name,parameters:{type:'object',properties:{query:{type:'string'},sql:{type:'string'}}}});tool.run=run;manager.registerTool(tool)};
  register('list_workflows',async()=>({workflows:[]}));
  register('search_schema',async()=>({mode:'data',dbSourceId:'source',selectedTables:['Invoices'],tables:tables.map(table=>({...table,semanticModel:{entity:'Invoices'}})),intentCatalog:tables}));
  register('execute_sql_query',async args=>{executed.push(args.sql);return {sql:args.sql,rows:[{Total:123}]}});
  const result=await new Harness({toolManager:manager,dispatch:async(_,messages,definitions)=>{
    if(messages[0]?.content?.startsWith('Return JSON only with operation'))return {content:JSON.stringify({operation:'aggregate',analysis:'none',attributes:[],presentation:'table',measures:[{table:'Invoices',column:'Amount',aggregation:'SUM'}],dataSql:'SELECT SUM(Amount) AS Total FROM Invoices'})};
    if(!messages.some(m=>m.role==='tool'))return {tool_calls:[{id:'schema',type:'function',function:{name:'search_schema',arguments:'{"query":"Invoices"}'}}]};
    return {content:'Total 123'};
  }}).run({userMessage:'Invoice total',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,mode:'data',dbSourceId:'source',requestPlan:{table:'Invoices',metric:'Qty',aggregation:'SUM',intent:'aggregate',schemaColumns:['Amount','Qty'],outputs:{data:true}}}});
  assert.equal(result.trace.completionStatus,'SUCCESS',JSON.stringify({evaluation:result.trace.training.responseEvaluation,steps:result.trace.steps,tools:result.toolCalls}));
  assert.equal(executed.length,1);
  assert.match(executed[0],/SUM\(Amount\)/);
});
