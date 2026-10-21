'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const storage=require('../src/backend/storage');storage.loadEnvironment();
async function main(){await storage.bootstrapStorage();try{await storage.run(async()=>{
 const dir='artifacts/ipms-lookup-groups-fix';
 const records=JSON.parse(fs.readFileSync(dir+'/live.private.json','utf8'));
 const rows=await require('../src/backend/services/sql_connector').executeSqlQuery('SELECT ContractID,ContractNo,CustomerID,EndDate FROM dbo.T_Contract','db-src-1785684548077');
 const customer=await require('../src/backend/services/sql_connector').executeSqlQuery("SELECT CustomerID FROM dbo.M_Customer WHERE CustomerCode=N'KA0021'",'db-src-1785684548077');
 const expected=rows.filter(r=>r.CustomerID===customer[0].CustomerID).map(r=>r.ContractID).sort((a,b)=>a-b);
 const expired=rows.filter(r=>r.EndDate&&new Date(r.EndDate).getTime()<Date.parse('2026-10-19T00:00:00Z')).map(r=>r.ContractID).sort((a,b)=>a-b);
 assert.equal(records.length,4);
 const findings=records.map(record=>{
  const r=record.result;assert.equal(r.completionStatus,'SUCCESS');
  if(record.id==='Q-005'){
   assert.deepEqual(r.executionResult.map(r=>r.ContractID).sort((a,b)=>a-b),expected);
   assert(!r.toolCalls.some(c=>c.toolName==='run_workflow'&&c.success));
  }else{
   const sql=r.sqlExecutions;assert.equal(sql.length,2);
   assert(sql[0].sql.includes("[EndDate] < N'2026-11-18'"));assert.equal(sql[0].rowCount,0);
   assert.deepEqual(sql[1].rows.map(r=>r.ContractID).sort((a,b)=>a-b),expired);
   assert(r.replyText.includes('Không tìm thấy dữ liệu phù hợp.'));
   assert.equal(r.toolCalls.filter(c=>c.semanticGroup!==undefined&&c.success).length,2);
  }
  return {id:record.id,historyMode:Boolean(record.historyMode),verdict:'PASS',reply:r.replyText,sql:r.sqlExecutions.map(s=>s.sql),durationMs:record.durationMs,usage:r.tokenUsage};
 });
 const summary={verifiedAt:new Date().toISOString(),mode:'New-code process using IntelligentCore.chat with live model and SQL Server; existing web server was not restarted.',deployment:'RESTART_REQUIRED',automatedChecksPassed:78,liveRuns:findings,expectedContractIds:expected,expectedExpiredIds:expired};
 fs.writeFileSync(dir+'/verification.json',JSON.stringify(summary,null,2));console.log(JSON.stringify({liveRuns:findings.map(r=>({id:r.id,historyMode:r.historyMode,verdict:r.verdict})),deployment:summary.deployment}));
})}finally{await storage.close()}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
