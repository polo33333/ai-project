'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const storage=require('../src/backend/storage');storage.loadEnvironment();
const dir='artifacts/ipms-capability-v2-191026';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function main(){await storage.bootstrapStorage();try{await storage.run(async()=>{
 const h=require('../src/backend/utils/storage_helper'),sql=require('../src/backend/services/sql_connector');
 const results=['results.private.json','history-results.private.json','superseded-attempts.private.json'].flatMap(name=>fs.existsSync(`${dir}/${name}`)?JSON.parse(fs.readFileSync(`${dir}/${name}`)):[]);
 const ids=new Set(results.map(r=>r.result?.auditId)),sessions=new Set(results.map(r=>r.sessionId));
 const audits=h.loadJson('chat_history.json',[]).filter(h=>ids.has(h.id));
 const repo=new (require('../src/backend/automation/repository').AutomationRepository)();
 const runs=[];
 for(const record of results.filter(r=>r.result?.execution?.id)){const run=await repo.get('runs',record.result.execution.id);if(run)runs.push(run);}
 fs.writeFileSync(`${dir}/all-audits.private.json`,JSON.stringify(audits,null,2),{mode:0o600});
 fs.writeFileSync(`${dir}/all-workflows.private.json`,JSON.stringify(runs,null,2),{mode:0o600});
 const oracle=JSON.parse(fs.readFileSync(`${dir}/oracle.private.json`));const stability=[];
 for(const [key,q]of Object.entries(oracle.queries)){const current=await sql.executeSqlQuery(q,oracle.sourceId);stability.push({key,beforeRows:oracle.data[key].length,afterRows:current.length,unchanged:hash(oracle.data[key])===hash(current)});}
 const catalog=h.loadJson('dictionary.json',[]).filter(t=>t.dbSourceId===oracle.sourceId&&t.isActive);
 fs.writeFileSync(`${dir}/verification.json`,JSON.stringify({checkedAt:new Date().toISOString(),audits:audits.length,runs:runs.map(r=>({id:r.id,conversationId:r.conversationId,status:r.status,error:r.error})),sourceStability:stability,activeTables:catalog.length,catalogHash:hash(catalog)},null,2));
 console.log(JSON.stringify({audits:audits.length,runs:runs.map(r=>({id:r.id,status:r.status,keys:Object.keys(r),error:r.error})),stability}));
})}finally{await storage.close()}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
