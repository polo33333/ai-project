'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const directory='artifacts/document-ai-eval';
const base='http://localhost:5500';
const safeProvider=p=>p?{id:p.id,name:p.name,model:p.model,type:p.type,supportsToolCalling:p.supportsToolCalling}:null;
async function main(){
 const credentials=JSON.parse(fs.readFileSync(0,'utf8'));
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
 if(!login.ok)throw new Error('LOGIN_FAILED');
 const headers={'Content-Type':'application/json',Cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
 const api=async(path,body)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();return {http:r.status,data};};
 try{
  const [me,providers,sources,library,tools]=await Promise.all(['/api/auth/me','/api/ai-providers','/api/sql/sources','/api/library','/api/tools'].map(x=>api(x)));
  const catalog=Array.isArray(providers.data)?providers.data:providers.data.providers||[];
  const active=providers.data.activeProvider||catalog.find(p=>p.isActive);
  const sourceList=Array.isArray(sources.data)?sources.data:sources.data.sources||[];
  const source=sourceList.find(x=>x.isDefault)||sourceList[0];
  const docs=Array.isArray(library.data)?library.data:library.data.documents||[];
  const env={base,recordedAt:new Date().toISOString(),account:{role:me.data.account?.role},provider:safeProvider(active),dbSource:source?{id:source.id,name:source.name,dbName:source.dbName,isDefault:source.isDefault}:null,
   sources:sourceList.map(x=>({id:x.id,name:x.name,dbName:x.dbName,isDefault:x.isDefault})),documents:docs.map(x=>({id:x.id,title:x.title,status:x.status,chunksCount:x.chunksCount})),tools:(tools.data.tools||[]).map(x=>({name:x.name,enabled:x.enabled}))};
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(directory+'/environment.json',JSON.stringify(env,null,2));console.log(JSON.stringify({phase:'preflight',...env}));
  if(process.argv.includes('--preflight'))return;
  if(process.argv.includes('--workflow-results-only')) {
    const records=JSON.parse(fs.readFileSync(directory+'/results.private.json'));
    const record=records.find(x=>x.id==='TRUST-03');
    const response=await api('/api/automation-runs?conversationId='+encodeURIComponent(record.sessionId));
    fs.writeFileSync(directory+'/workflow-followup.private.json',JSON.stringify(response,null,2));
    console.log(JSON.stringify({phase:'workflow-followup',http:response.http,runs:response.data.runs?.map(x=>({id:x.id,status:x.status,error:x.error,templateId:x.templateId}))}));return;
  }
  if(process.argv.includes('--oracle-only')) {
    const response=await api('/api/tools/execute',{toolName:'execute_sql_query',dbSourceId:source?.id,args:{sql:'SELECT IsActive, COUNT(*) AS SoLuong FROM M_Customer GROUP BY IsActive'}});
    fs.writeFileSync(directory+'/customer-status-oracle.private.json',JSON.stringify({recordedAt:new Date().toISOString(),sourceId:source?.id,...response},null,2));
    console.log(JSON.stringify({phase:'oracle',http:response.http,success:response.data.success,keys:Object.keys(response.data)}));return;
  }
  if(process.argv.includes('--sources-only')) {
    const doc=docs.find(x=>x.title.includes('HDSD_IPMS'));
    const content=await api('/api/library/'+encodeURIComponent(doc.id)+'/content');
    fs.writeFileSync(directory+'/ipms-guide.private.json',JSON.stringify({id:doc.id,title:doc.title,http:content.http,...content.data},null,2));
    console.log(JSON.stringify({phase:'source',id:doc.id,http:content.http,keys:Object.keys(content.data),length:String(content.data.content||'').length}));return;
  }

  const suite=JSON.parse(fs.readFileSync(directory+'/suite.json','utf8'));
  const resultPath=directory+'/results.private.json';
  const results=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):[];
  const already=new Set(results.map(x=>x.id));
  const limitArg=process.argv.find(x=>x.startsWith('--limit='));
  const pending=suite.cases.filter(x=>!already.has(x.id)).slice(0,limitArg?Number(limitArg.split('=')[1]):Infinity);
  const runId=crypto.randomUUID();
  const safeResult=data=>{const copy={...data};copy.provider=safeProvider(data.provider);return copy;};
  let next=0;
  async function worker(){
   while(next<pending.length){
    const item=pending[next++],started=Date.now(),sessionId='doc-eval-'+runId.slice(0,8)+'-'+item.id;
    const record={id:item.id,sourceKind:item.sourceKind,question:item.question,startedAt:new Date().toISOString(),sessionId};
    try{
     const response=await fetch(base+'/api/intelligent-core/chat',{method:'POST',headers:{...headers,'X-Request-ID':crypto.randomUUID()},body:JSON.stringify({question:item.question,history:[],sessionId,providerId:active?.id,dbSourceId:source?.id,webSearch:false,knowledgeSearchEnabled:true}),signal:AbortSignal.timeout(240000)});
     record.http=response.status;record.result=safeResult(await response.json());
    }catch(error){record.http=0;record.transportError=error.name+': '+error.message;}
    record.durationMs=Date.now()-started;results.push(record);results.sort((a,b)=>suite.cases.findIndex(x=>x.id===a.id)-suite.cases.findIndex(x=>x.id===b.id));
    fs.writeFileSync(resultPath,JSON.stringify(results,null,2));
    console.log(JSON.stringify({phase:'case',id:item.id,completed:results.length,total:suite.cases.length,http:record.http,status:record.result?.completionStatus||record.result?.status,ms:record.durationMs,tokens:record.result?.tokenUsage,tools:record.result?.toolCalls?.map(x=>x.name),preview:(record.result?.reply||record.result?.message||record.transportError||'').slice(0,150)}));
   }
  }
  await Promise.all([worker(),worker()]);
  const audits=await api('/api/chat-history');
  const ids=new Set(results.map(x=>x.result?.auditId).filter(Boolean)),sessions=new Set(results.map(x=>x.sessionId));
  const selected=(Array.isArray(audits.data)?audits.data:audits.data.history||[]).filter(x=>ids.has(x.id)||sessions.has(x.requestPayload?.sessionId));
  const safeAudits=selected.map(x=>({id:x.id,status:x.status,question:x.question,latencyMs:x.latencyMs,errorReason:x.errorReason,diagnostics:x.requestPayload?.diagnostics,toolCalls:x.requestPayload?.toolCalls,tokenUsage:x.requestPayload?.tokenUsage,memoryDecision:x.requestPayload?.memoryDecision,sessionId:x.requestPayload?.sessionId}));
  fs.writeFileSync(directory+'/audits.private.json',JSON.stringify(safeAudits,null,2));
  console.log(JSON.stringify({phase:'done',completed:results.length,total:suite.cases.length,audits:safeAudits.length}));

 }finally{await fetch(base+'/api/auth/logout',{method:'POST',headers});}
}
main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
