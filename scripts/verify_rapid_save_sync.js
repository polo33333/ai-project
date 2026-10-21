'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const wait = ms => new Promise(done => setTimeout(done,ms));
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0,'utf8'));
  const base='http://localhost:5500';
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(login.status,200,'LOGIN_FAILED');
  const headers={'Content-Type':'application/json',Cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
  const api=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const evidence={};
  try {
    if(process.argv.includes('--restart')) {
      assert.equal((await api('/api/settings/restart',{})).status,202); await wait(1800);
      for(let i=0;i<30;i++) {try {if((await api('/api/auth/me')).status===200)break;}catch{} await wait(500);}
    }
    if (process.argv.includes('--restart-only')) { assert.equal((await api('/api/dictionary/sync-status')).status,200); console.log('RESTARTED_AND_READY'); return; }
    const before=(await api('/api/dictionary')).data;
    const tables=Array.isArray(before)?before:before.tables;
    assert.ok(tables.length,'NO_DICTIONARY_TABLES');
    const payload={tableId:tables[0].tableId,tableName:tables[0].tableName,table:{},columns:[],relationships:[]};
    const responses=await Promise.all(Array.from({length:3},()=>api('/api/dictionary/save-table-configuration',payload)));
    evidence.rapidSaves=responses.map(x=>({status:x.status,scheduled:x.data.vectorSync?.scheduled===true}));
    console.log(JSON.stringify({phase:'save-responses',responses:responses.map(x=>({status:x.status,state:x.data.status,scheduled:x.data.vectorSync?.scheduled,message:x.data.message}))}));
    assert.ok(responses.every(x=>x.status===200&&x.data.vectorSync?.scheduled));
    assert.deepEqual((await api('/api/dictionary')).data,before,'Metadata must remain unchanged by the no-op save probe');
    evidence.metadataUnchanged=true;
    evidence.queue=(await api('/api/dictionary/sync-status')).data;
    console.log(JSON.stringify({phase:'database',...evidence}));
    require('../src/backend/storage').loadEnvironment();
    const qdrant=require('../src/backend/services/qdrant_service');
    const instance=new qdrant.constructor();
    const temporary='ui-sync-check-'+crypto.randomUUID(); instance.collectionName=temporary;
    try {
      const glossary=label=>[{term:'Kiểm tra đồng bộ '+label,fullMeaning:'Dữ liệu nghiệm thu tạm thời',category:'Kiểm thử'}];
      const results=await Promise.all([instance.syncTablesToQdrant([],glossary('A')),instance.syncTablesToQdrant([],glossary('B'))]);
      assert.ok(results.every(x=>x.success));
      const points=await instance.request('/collections/'+temporary+'/points/scroll','POST',{limit:10,with_payload:true,with_vector:false});
      assert.equal(points.result.points.length,1);assert.equal(points.result.points[0].payload.term,glossary('B')[0].term);
      const previous=instance.embedTexts; instance.embedTexts=async()=>{throw new Error('ACCEPTANCE_SIMULATED_EMBEDDING_FAILURE');};
      assert.equal((await instance.syncTablesToQdrant([],glossary('C'))).success,false);instance.embedTexts=previous;
      const after=await instance.request('/collections/'+temporary+'/points/scroll','POST',{limit:10,with_payload:true,with_vector:false});
      assert.deepEqual(after.result.points,points.result.points);
      evidence.liveVector={serialized:true,latestSnapshot:true,preservedOnEmbeddingFailure:true};
    } finally {assert.ok(temporary.startsWith('ui-sync-check-'));await instance.request('/collections/'+temporary,'DELETE');}
    evidence.queueAfterVectorProbe=(await api('/api/dictionary/sync-status')).data;
    fs.mkdirSync('artifacts/ui-review',{recursive:true});fs.writeFileSync('artifacts/ui-review/rapid-save-sync-live.json',JSON.stringify(evidence,null,2));
    console.log(JSON.stringify(evidence));
  } finally {await fetch(base+'/api/auth/logout',{method:'POST',headers});}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
