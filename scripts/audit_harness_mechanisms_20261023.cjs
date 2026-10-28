'use strict';
// Diagnostic probes only: fake tables/rows, isolated storage, no provider or SQL server.
// These assert current observations, not desired product behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { bind } = require('../src/backend/agent/harness/request_filters');
const { matchesScope } = require('../src/backend/agent/harness/schema_scope');
const { assessSqlEvidence, stableFingerprint, evaluateCompletion } = require('../src/backend/agent/harness/completion_policy');
const { createRequestContract, assessRequestContract } = require('../src/backend/agent/harness/request_contract');
const { validateSqlAgainstJoinPlan } = require('../src/backend/services/sql_join_validator');
const observations=[];
function record(id, observed, expected, meaning) { assert.deepEqual(observed,expected,id); observations.push({id,observed,meaning}); }
const tables=[{tableName:'Documents',columns:[{name:'CycleID',type:'INT'}]}];
const question='Details for cycle 20';
const filters=bind([{table:'Documents',column:'CycleID',value:20,evidence:'cycle 20'}],tables,question);
record('F01-empty-extraction',matchesScope('SELECT CycleID FROM Documents',bind([],tables,question)),true,'Empty extracted filters do not detect a missing explicit qualifier.');
record('C01-bound-filter-protected',matchesScope('SELECT CycleID FROM Documents',filters),false,'When the filter is bound, dropping it is blocked.');
record('F02-equivalent-in',matchesScope('SELECT CycleID FROM Documents WHERE CycleID IN (20)',filters),false,'Equivalent singleton IN is rejected by equality-only scope verifier.');
record('F03-schema-identity',matchesScope('SELECT d.CycleID FROM archive.Documents d WHERE d.CycleID=20',filters),true,'Filter identity has no schema; separate source/table permission checks still apply.');
const plan={table:'Invoices',intent:'aggregate',metric:'Amount',aggregation:'SUM',conversationState:{operation:'aggregate'}};
const sqlCall=sql=>({toolName:'execute_sql_query',success:true,args:{sql},result:{sql,rows:[{Total:0}]}});
record('F04-aggregate-expression',assessSqlEvidence(sqlCall('SELECT SUM(Amount) * 0 AS Total FROM Invoices'),plan).accepted,true,'Projected aggregate exists but surrounding arithmetic changes requested SUM.');
record('F05-aggregate-alias',assessSqlEvidence(sqlCall('SELECT SUM(Invoices.Amount) AS Total FROM Credits Invoices JOIN Invoices i ON i.ID=Invoices.ID'),{...plan,requiredMeasures:[{table:'Invoices',column:'Amount',aggregation:'SUM'}]}).accepted,true,'Alias equal to expected table can pass measure provenance at evidence layer; JOIN permission checks remain separate.');
const contract=createRequestContract({table:'Invoices',conversationState:{operation:'attribute',requestedAttributes:['Amount']}},{tables:[{tableName:'Invoices',columns:[{name:'Amount',label:'Amount'}]}]});
record('F06-root-output-lineage',assessRequestContract(contract,sqlCall('SELECT 0 AS Amount FROM Invoices')).complete,false,'Control: row key Total does not satisfy Amount.');
record('F06-root-output-alias',assessRequestContract(contract,{success:true,args:{sql:'SELECT 0 AS Amount FROM Invoices'},result:{rows:[{Amount:0}]}}).complete,true,'Root-field contract accepts matching result alias without proving physical projection.');
record('F07-sql-fingerprint',stableFingerprint('execute_sql_query',{sql:'SELECT ID FROM Documents'})===stableFingerprint('execute_sql_query',{sql:'SELECT  ID FROM Documents'}),false,'Whitespace variants are different no-progress fingerprints.');
record('F11-analysis-conclusion',evaluateCompletion({reply:'Tháng này bất thường.',plan:{table:'Invoices',outputs:{data:true},analysisTask:'anomaly'},toolCalls:[sqlCall('SELECT Amount FROM Invoices')]}).valid,true,'Completion layer accepts unsupported anomaly wording outside its narrow row-summary regex; full harness has additional short-series handling.');
const joinPlan={outcome:'ready',tableRefs:[{tableRefId:'p',tableId:'p',tableName:'Parents',schemaName:'dbo'},{tableRefId:'c',tableId:'c',tableName:'Children',schemaName:'dbo'}],edges:[{relationshipId:'r',fromTableRefId:'p',toTableRefId:'c',fromTableId:'p',toTableId:'c',cardinality:'one-to-many',columnPairs:[{sourceColumn:'ID',targetColumn:'ParentID'}]}]};
record('C02-direct-fanout-blocked',validateSqlAgainstJoinPlan('SELECT SUM(p.Amount) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID',joinPlan).valid,false,'Direct parent SUM is blocked.');
record('F08-expression-fanout',validateSqlAgainstJoinPlan('SELECT SUM(COALESCE(p.Amount,0)) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID',joinPlan).valid,true,'JOIN grain guard skips non-column aggregate arguments; separate measure guard may reject if correctly bound.');
const previous=process.env.SQL_JOIN_PLANNER_ENABLED;
process.env.SQL_JOIN_PLANNER_ENABLED='false';
record('F09-flag-off',validateSqlAgainstJoinPlan('SELECT a.ID FROM A a JOIN B b ON a.ID=b.ID',null).valid,true,'Planner flag off plus absent plan bypasses relationship enforcement, not read-only/source authorization.');
if(previous===undefined)delete process.env.SQL_JOIN_PLANNER_ENABLED;else process.env.SQL_JOIN_PLANNER_ENABLED=previous;
async function rawTopProbe(){
 const connector=require('../src/backend/services/sql_connector');
 const original=connector.executeSqlQuery;
 connector.executeSqlQuery=async()=>[{ID:1},{ID:2}];
 try{
  const {ExecuteSqlTool}=require('../src/backend/agent/tools/builtins');
  const result=await new ExecuteSqlTool().run({sql:'SELECT TOP 2 ID FROM Documents'},{dbSourceId:'synthetic'});
  record('F12-raw-top-completeness',{rowCount:result.rowCount,hasCompletenessFlag:Object.hasOwn(result,'hasMore')||Object.hasOwn(result,'truncated')},{rowCount:2,hasCompletenessFlag:false},'Raw TOP query has no completeness flag. Connector mocked, no live DB.');
 }finally{connector.executeSqlQuery=original;}
}
async function stagedProbe(){
 const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
 const Base=require('../src/backend/agent/tools/base_tool');
 const Manager=require('../src/backend/agent/tools/tool_manager');
 const manager=new Manager(), executed=[], offered=[];
 for(const name of ['list_workflows','search_schema','execute_sql_query']){
   const tool=new Base({name,description:name,parameters:{type:'object',properties:{sql:{type:'string'},query:{type:'string'}}}});
   tool.run=async args=>name==='list_workflows'?{workflows:[]}:name==='search_schema'?(executed.push(args.query),{mode:'data',dbSourceId:'fixture',selectedTables:['Records'],tables:[{tableName:'Records',columns:[{name:args.query}]}]}):{sql:args.sql,rows:[{Amount:25}]};manager.registerTool(tool);
 }
 const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const responses=[call('list_workflows',{}),...['First','Second','Amount'].map(query=>call('search_schema',{query})),call('execute_sql_query',{sql:'SELECT SUM(Amount) AS Amount FROM Records'})];
 await new Harness({toolManager:manager,dispatch:async(_p,_m,defs)=>{offered.push(defs.map(d=>d.function?.name||d.name));return responses.shift()||{content:'25'};}}).run({userMessage:'total amount',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,dbSourceId:'fixture',mode:'data',requestPlan:{table:'Records',intent:'aggregate',schemaColumns:['Amount'],outputs:{data:true},schemaScope:{filters:[]},conversationState:{operation:'aggregate',requestedAttributes:[]}}}});
 record('F10-stage-execution',{thirdSchemaOffered:offered[3].includes('search_schema'),executed},{thirdSchemaOffered:false,executed:['First','Second','Amount']},'Third schema tool executes even though it was removed from stage definitions.');
}
(async()=>{await rawTopProbe();await stagedProbe();fs.mkdirSync('output/harness-system-review-20261023',{recursive:true});fs.writeFileSync('output/harness-system-review-20261023/probes.json',JSON.stringify({at:new Date().toISOString(),scope:'isolated synthetic probes; no live DB/provider',observations},null,2));console.log(JSON.stringify(observations,null,2));})().catch(error=>{console.error(error);process.exitCode=1;});
