'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const storage=require('../src/backend/storage');storage.loadEnvironment();
async function main(){await storage.bootstrapStorage();const records=[];try{
 for(const historyMode of [false,true])await storage.run(()=>require('../src/backend/governance/context').run(async()=>{
  const h=require('../src/backend/utils/storage_helper'),account=h.loadJson('accounts.json',[]).find(a=>a.role==='admin'&&a.isActive!==false);
  require('../src/backend/governance/context').setPrincipal({subject:'account:'+account.id,role:'admin',channel:'chat'});
  const provider=h.loadJson('ai_providers.json',[]).find(p=>p.isActive);
  const seed=JSON.parse(fs.readFileSync('artifacts/ipms-q007-fix/audits.private.json','utf8')).find(r=>r.question==='Liệt kê tất cả hợp đồng của khách hàng KA0021');
  const question='Tiền điện trên hóa đơn của KA0021 trong 2024-02 là bao nhiêu';
  const result=await require('../src/backend/intelligent_core/core').chat(question,{providerId:provider.id,dbSourceId:'db-src-1785684548077',history:historyMode?[{role:'user',content:seed.question},{role:'assistant',content:seed.replyText}]:[],useTools:true,knowledgeSearchEnabled:true,webSearch:false,permissions:['admin'],session:{id:'q007-fix-'+crypto.randomUUID(),accountId:account.id}});
  delete result.usedProvider;records.push({historyMode,question,result});fs.writeFileSync('artifacts/ipms-q007-fix/live.private.json',JSON.stringify(records,null,2),{mode:0o600});
  console.log(JSON.stringify({historyMode,status:result.completionStatus,reply:result.replyText,sql:result.sqlQuery,tools:result.toolCalls.map(t=>({tool:t.toolName,success:t.success,error:t.error})),rootRecovery:result.trace?.steps?.filter(s=>s.type==='SCHEMA_ROOT_RECOVERY')}));
 }));
}finally{await storage.close()}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
