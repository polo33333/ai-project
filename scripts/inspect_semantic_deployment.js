'use strict';
const fs=require('fs');
async function main(){
 const b='http://localhost:5500',login=await fetch(b+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:fs.readFileSync(0,'utf8')});if(!login.ok)throw Error('login');
 const headers={Cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 try{
  const [tables,relations,sync]=await Promise.all(['/api/dictionary','/api/dictionary/relationships','/api/dictionary/sync-status'].map(async p=>{const r=await fetch(b+p,{headers});if(!r.ok)throw Error(p+' '+r.status);return r.json()}));
  const active=tables.filter(t=>t.isActive&&t.dbSourceId==='db-src-1785684548077');
  const customer=active.find(t=>t.tableName==='M_Customer'),project=require('../src/backend/services/semantic_model').project,compact=require('../src/backend/agent/harness/agent_context').compactAgentToolResult;
  const complete=project([customer],{operation:'describe',attributes:[]}).tables,summary=project([customer],{operation:'list',attributes:[]}).tables;
  const result={activeTables:active.length,classified:active.filter(t=>t.domain).length,domainCount:new Set(active.map(t=>t.domain)).size,
   verifiedRelationships:relations.filter(r=>r.status==='verified').length,sync,
   customerContext:{fullColumns:complete[0].columns.length,summaryColumns:summary[0].columns.length,
    fullChars:compact('search_schema',{success:true,result:{tables:complete}},100000).length,
    summaryChars:compact('search_schema',{success:true,result:{tables:summary}},100000).length},
   tables:active.map(t=>({table:t.tableName,domain:t.domain,entity:t.semanticModel?.entity,kind:t.semanticModel?.kind,currency:t.semanticModel?.defaultCurrency}))};
  fs.writeFileSync('artifacts/semantic-model/deployment-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await fetch(b+'/api/auth/logout',{method:'POST',headers})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
