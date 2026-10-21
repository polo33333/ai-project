'use strict';
const fs=require('fs'),crypto=require('crypto');
const cases=[
 ['customers','ds kh'],
 ['cost','Tổng chi phí vận hành của điện bán là bao nhiêu?'],
 ['compare','So sánh điện thoại và email của nhân viên NV006 và NV007'],
 ['trend','Thống kê tổng sản lượng điện bán theo từng tháng có dữ liệu'],
 ['customer_cost','Thống kê tổng chi phí vận hành điện bán theo khách hàng']
];
async function main(){
 const selectedCases=process.argv[2]?cases.filter(([id])=>process.argv[2].split(',').includes(id)):cases;
 const stem=process.argv[3]||'capabilities';
 const b='http://localhost:5500',credentials=JSON.parse(fs.readFileSync(0,'utf8')),env=JSON.parse(fs.readFileSync('artifacts/document-ai-eval/environment.json'));
 const login=await fetch(b+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});if(!login.ok)throw Error('login');
 const headers={'Content-Type':'application/json',Cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')},records=[];
 try{
  for(const[id,question]of selectedCases){
   const r=await fetch(b+'/api/intelligent-core/chat',{method:'POST',headers,body:JSON.stringify({question,history:[],sessionId:'semantic-capability-'+crypto.randomUUID(),providerId:env.provider.id,dbSourceId:env.dbSource.id,webSearch:false,knowledgeSearchEnabled:true}),signal:AbortSignal.timeout(180000)});
   const result=await r.json();records.push({id,question,result});fs.writeFileSync('artifacts/semantic-model/'+stem+'.json',JSON.stringify({records},null,2));
   console.log(JSON.stringify({id,status:result.completionStatus,input:result.tokenUsage?.inputTokens,calls:result.tokenUsage?.calls,reply:result.reply,sql:result.generatedSql,errors:result.toolCalls?.filter(c=>!c.success).map(c=>c.error)}));
  }
  const history=await(await fetch(b+'/api/chat-history',{headers})).json(),ids=new Set(records.map(r=>r.result.auditId));
  fs.writeFileSync('artifacts/semantic-model/'+stem+'-audits.json',JSON.stringify(history.filter(h=>ids.has(h.id)).map(h=>({id:h.id,diagnostics:h.requestPayload?.diagnostics,sql:h.sqlQuery})),null,2));
 }finally{await fetch(b+'/api/auth/logout',{method:'POST',headers})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
