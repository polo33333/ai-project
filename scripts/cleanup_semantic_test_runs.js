'use strict';
const fs=require('fs');
async function main(){
 const ids=new Set();
 for(const file of fs.readdirSync('artifacts/semantic-model').filter(f=>f.startsWith('capabilities')&&f.endsWith('.json')&&!f.includes('audit'))){
  for(const row of JSON.parse(fs.readFileSync('artifacts/semantic-model/'+file)).records||[]){const id=row.result.answerEnvelope?.executionRef?.runId;if(id)ids.add(id);}
 }
 const b='http://localhost:5500',login=await fetch(b+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:fs.readFileSync(0,'utf8')});if(!login.ok)throw Error('login');
 const headers={'Content-Type':'application/json',Cookie:login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')},out=[];
 try{for(const id of ids){
  const r=await fetch(b+'/api/automation-runs/'+encodeURIComponent(id),{headers});if(!r.ok){out.push({id,skipped:true,http:r.status});continue;}
  const {execution}=await r.json();
  if(!execution.conversationId?.startsWith('semantic-capability-'))throw Error('Refusing to cancel non-test conversation');
  if(['SUCCEEDED','FAILED','CANCELLED'].includes(execution.status)){out.push({id,status:execution.status});continue;}
  const cancelled=await fetch(b+'/api/automation-runs/'+encodeURIComponent(id)+'/cancel',{method:'POST',headers,body:JSON.stringify({revision:execution.revision})});
  const result=await cancelled.json();if(!cancelled.ok)throw Error('cancel '+cancelled.status);
  out.push({id,status:result.execution.status});
 }fs.writeFileSync('artifacts/semantic-model/test-run-cleanup.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));}
 finally{await fetch(b+'/api/auth/logout',{method:'POST',headers})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
