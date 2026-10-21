'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const storage=require('../src/backend/storage');storage.loadEnvironment();
const {requestStores}=require('../src/backend/storage/request_stores');
const {buildTrainingReport}=require('../src/backend/training_core/report_service');
async function main(){
 await storage.bootstrapStorage();
 try{
  const report={createdAt:new Date().toISOString(),storeReads:[],audit:{},training:{}};
  const tabs={accounts:['/api/accounts','/api/accounts/roles','/api/accounts/embed-identity'],settings:['/api/settings','/api/backups','/api/backups/status'],memory:['/api/memory','/api/memory/events'],
   library:['/api/library'],watchfolder:['/api/watchfolder','/api/watchfolder/logs'],sql:['/api/sql/sources'],dictionary:['/api/dictionary/workspace'],glossary:['/api/glossary'],
   providers:['/api/ai-providers'],system_logs:['/api/logs'],history:['/api/chat-history?list=1'],feedback:['/api/chat-feedback?list=1'],
   training:['/api/training-report','/api/training/skills'],workflows:['/api/workflow-plugins','/api/automation-runs'],mcp:['/api/mcp/servers'],tools:['/api/tools'],api_docs:['/api/keys','/api/embed/configs'],page_chat:['/api/chat/providers','/api/page-chat/sessions']};
  for(const [tab,paths]of Object.entries(tabs))for(const url of paths){
   const files=requestStores({method:'GET',url}),start=performance.now();
   await storage.run(()=>{}, {files});report.storeReads.push({tab,url,ms:Math.round(performance.now()-start),stores:files.length});
  }
  let raw,oldFeedback,oldTraining,feedback;
  let start=performance.now();
  await storage.run(()=>{
   const logger=require('../src/backend/services/logger_service');raw=structuredClone(logger.chatHistory);feedback=structuredClone(logger.chatFeedback);oldFeedback=logger.getChatFeedback();
   oldTraining=buildTrainingReport();
  },{files:['chat_history.json','chat_feedback.json','training_resolutions.json']});
  report.audit.fullReadMs=Math.round(performance.now()-start);report.audit.fullBytes=Buffer.byteLength(JSON.stringify(raw));
  const reader=require('../src/backend/services/audit_reader');start=performance.now();
  const list=await reader.list({id:'benchmark',role:'admin'});
  report.audit.listMs=Math.round(performance.now()-start);report.audit.listBytes=Buffer.byteLength(JSON.stringify(list));report.audit.rows=list.length;
  assert.deepEqual(list.map(x=>x.id),raw.map(x=>x.id));
  for(const item of list){const old=raw.find(x=>x.id===item.id);for(const field of ['question','status','timestamp','latencyMs','modelName'])assert.equal(item[field]??null,old[field]??null);}
  if(raw.length){
   start=performance.now();const selected=await reader.detail(raw[0].id,{id:'benchmark',role:'admin'});
   report.audit.detailMs=Math.round(performance.now()-start);assert.deepEqual(selected,raw[0]);report.audit.detailVerified=true;
  }else report.audit.detailVerified=null;
  start=performance.now();const compactFeedback=await reader.feedback();report.audit.feedbackMs=Math.round(performance.now()-start);
  assert.equal(compactFeedback.length,oldFeedback.length);
  for(let i=0;i<compactFeedback.length;i++)for(const field of ['question','replyText','sqlQuery','timestamp','modelName'])assert.equal(compactFeedback[i].audit?.[field]??null,oldFeedback[i].audit?.[field]??null);
  const ids=[...new Map(feedback.map(x=>[x.auditId,x])).values()].filter(x=>x.reviewStatus==='needs_review').map(x=>x.auditId).filter(Boolean);
  start=performance.now();const trainingHistory=await reader.records(ids);let newTraining;
  await storage.run(()=>{newTraining=buildTrainingReport(undefined,{history:trainingHistory,feedback});},{files:['training_resolutions.json']});
  report.training={ms:Math.round(performance.now()-start),reviewedAudits:ids.length,cases:newTraining.cases.length};
  delete newTraining.generatedAt;delete oldTraining.generatedAt;assert.deepEqual(newTraining,oldTraining);report.training.verified=true;
  fs.mkdirSync('artifacts/tab-performance',{recursive:true});fs.writeFileSync('artifacts/tab-performance/audit.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
 }finally{await storage.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
