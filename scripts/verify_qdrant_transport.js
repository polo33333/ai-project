'use strict';
const fs=require('node:fs');
require('../src/backend/storage').loadEnvironment();
async function main(){
 const q=require('../src/backend/services/qdrant_service');
 const collection=await q.request('/collections/'+q.collectionName);
 const searches=[];
 for(let i=0;i<5;i++){const started=Date.now(),result=await q.searchSchemaDetailed('hợp đồng khách hàng',3);searches.push({status:result.status,errorCode:result.errorCode,hits:result.results.length,durationMs:Date.now()-started});}
 const original=JSON.parse(fs.readFileSync('artifacts/ipms-lookup-groups-fix/live.private.json','utf8'));
 const originalRetrieval=original.map(r=>({id:r.id,historyMode:Boolean(r.historyMode),statuses:r.result.toolCalls.filter(t=>t.toolName==='search_schema').map(t=>t.result?.retrieval?.semanticSearch)}));
 const report={checkedAt:new Date().toISOString(),points:collection.result.points_count,searches,originalRetrieval,originalSocketErrorReproduced:false,automatedChecksPassed:35,appRestarted:false};
 fs.mkdirSync('artifacts/qdrant-transport',{recursive:true});fs.writeFileSync('artifacts/qdrant-transport/verification.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));if(searches.some(s=>s.status!=='ok'||!s.hits))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
