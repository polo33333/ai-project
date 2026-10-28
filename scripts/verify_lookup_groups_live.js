'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const storage=require('../src/backend/storage');storage.loadEnvironment();
const directory='artifacts/ipms-lookup-groups-fix';fs.mkdirSync(directory,{recursive:true});
async function main(){await storage.bootstrapStorage();const records=fs.existsSync(directory+'/live.private.json')?JSON.parse(fs.readFileSync(directory+'/live.private.json','utf8')):[];try{
 for(const [id,question,historyMode]of [['Q-005','Liệt kê tất cả hợp đồng của khách hàng KA0021',false],['Q-006','Tìm hợp đồng sẽ hết hạn trong 30 ngày từ 2026-10-19; tách hợp đồng đã hết hạn',false],['Q-005','Liệt kê tất cả hợp đồng của khách hàng KA0021',true],['Q-006','Tìm hợp đồng sẽ hết hạn trong 30 ngày từ 2026-10-19; tách hợp đồng đã hết hạn',true]]){
  if(records.some(r=>r.id===id&&Boolean(r.historyMode)===historyMode))continue;
  await storage.run(()=>require('../src/backend/governance/context').run(async()=>{
   const h=require('../src/backend/utils/storage_helper'),account=h.loadJson('accounts.json',[]).find(a=>a.role==='admin'&&a.isActive!==false);
   require('../src/backend/governance/context').setPrincipal({subject:'account:'+account.id,role:'admin',channel:'chat'});
   const provider=h.loadJson('ai_providers.json',[]).find(p=>p.isActive);
   const started=Date.now();
   const seed=records.find(r=>r.id==='Q-005'&&!r.historyMode);
   const result=await require('../src/backend/assistant/core').chat(question,{providerId:provider.id,dbSourceId:'db-src-1785684548077',history:historyMode?[{role:'user',content:seed.question},{role:'assistant',content:seed.result.replyText}]:[],useTools:true,knowledgeSearchEnabled:true,webSearch:false,permissions:['admin'],session:{id:'lookup-groups-fix-'+crypto.randomUUID(),accountId:account.id}});
   delete result.usedProvider;
   records.push({id,question,historyMode,durationMs:Date.now()-started,result});fs.writeFileSync(directory+'/live.private.json',JSON.stringify(records,null,2),{mode:0o600});
   console.log(JSON.stringify({id,keys:Object.keys(result),reply:result.reply||result.replyText,status:result.completionStatus||result.trace?.completionStatus,tools:result.toolCalls?.map(c=>({name:c.toolName,success:c.success,error:c.error})),trace:result.trace?.steps?.filter(s=>['SEMANTIC_GROUPS_DISPATCHED','SEMANTIC_INTENT_REVIEW_UNAVAILABLE'].includes(s.type))}));
  }));
 }
}finally{await storage.close()}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
