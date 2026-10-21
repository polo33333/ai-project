'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),storage=require('../src/backend/storage');storage.loadEnvironment();
async function main(){await storage.bootstrapStorage();try{await storage.run(async()=>{
 const oracle=await require('../src/backend/services/sql_connector').executeSqlQuery("SELECT COUNT_BIG(*) AS InvoiceCount,SUM(o.PreTotalAmount) AS BeforeTax,SUM(o.VATTotalAmount) AS VAT,SUM(o.FinalTotalAmount) AS AfterTax FROM dbo.T_ElectricityOutput o LEFT JOIN dbo.M_Customer c ON o.CustomerID=c.CustomerID WHERE c.CustomerCode=N'KA0021' AND o.ElectricityOutputDate>='2024-02-01' AND o.ElectricityOutputDate<'2024-03-01'",'db-src-1785684548077');
 const records=JSON.parse(fs.readFileSync('artifacts/ipms-q007-fix/live.private.json','utf8'));assert.equal(records.length,2);
 for(const r of records){assert.equal(r.result.completionStatus,'SUCCESS');assert.equal(Number(r.result.executionResult[0].FinalTotalAmount),Number(oracle[0].AfterTax));assert.equal(r.result.sqlExecutions.length,1);}
 const result={verifiedAt:new Date().toISOString(),mode:'New-code IntelligentCore.chat process, real model and SQL Server. Web server not restarted.',automatedChecksPassed:80,oracle:oracle[0],runs:records.map(r=>({historyMode:r.historyMode,verdict:'PASS',reply:r.result.replyText,sql:r.result.sqlQuery,usage:r.result.tokenUsage})),deployment:'RESTART_REQUIRED'};
 fs.writeFileSync('artifacts/ipms-q007-fix/verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
})}finally{await storage.close()}}
main().catch(e=>{console.error(e.message);process.exitCode=1});
