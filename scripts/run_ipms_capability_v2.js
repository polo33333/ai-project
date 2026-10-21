'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const storage=require('../src/backend/storage');storage.loadEnvironment();
const dir='artifacts/ipms-capability-v2-191026',sourceId='db-src-1785684548077',base='http://localhost:5500';
const historyMode=process.argv.includes('--history');
const resultFile=historyMode?'history-results.private.json':'results.private.json';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(name,data)=>fs.writeFileSync(`${dir}/${name}`,JSON.stringify(data,null,2),{mode:0o600});
async function main(){
 fs.mkdirSync(dir,{recursive:true});await storage.bootstrapStorage();let cookie,provider;
 try{
 await storage.run(async()=>{
  const h=require('../src/backend/utils/storage_helper');const accounts=h.loadJson('accounts.json',[]),sessions=h.loadJson('sessions.json',{});
  const entry=Object.entries(sessions).find(([token,s])=>s.expiresAt>Date.now()+600000&&accounts.some(a=>a.id===s.accountId&&a.role==='admin'&&a.isActive!==false&&(a.securityVersion||0)===(s.securityVersion||0)));
  if(!entry)throw Error('No valid local admin session for evaluation');cookie='kh_session='+encodeURIComponent(entry[0]);
  provider=h.loadJson('ai_providers.json',[]).find(p=>p.isActive);if(!provider)throw Error('No active provider');
  const sql=require('../src/backend/services/sql_connector');
  if(!fs.existsSync(`${dir}/oracle.private.json`)){
   const queries={customers:'SELECT CustomerID,CustomerCode,CustomerName,CustomerGroupID,TypeID,IsActive,Email,Phone,TaxCode,Address,ContactName FROM dbo.M_Customer',contracts:'SELECT ContractID,ContractNo,ContractDate,CustomerID,StartDate,EndDate,TotalArea,ContractTypeID,StatusID FROM dbo.T_Contract',outputs:'SELECT ElectricityOutputID,ElectricityOutputCode,CustomerID,ElectricityOutputDate,PeriodID,FromDate,ToDate,TotalQty,PreTotalAmount,VATTotalAmount,FinalTotalAmount,ClosingBalance_Debit FROM dbo.T_ElectricityOutput',details:'SELECT ElectricityOutputDetailID,ElectricityOutputID,HoUID,Multiplier,OldIndex,NewIndex,Qty,Price,PreAmount,VATAmount,FinalAmount FROM dbo.T_ElectricityOutputDetail',inputs:'SELECT ElectricityInputID,ElectricityInputDate,PeriodID,TotalQty FROM dbo.T_ElectricityInput',lots:'SELECT LandTaskForRentID,LandLot,ParentID,LandArea,StatusID FROM dbo.T_LandTaskForRent',tickets:'SELECT FeedbackID,CustomerID,FeedbackDate,Title,StatusID FROM dbo.T_Feedback',receipts:'SELECT RevenueID,RevenueCode FROM dbo.T_Revenue',vouchers:'SELECT ExpenseID,ExpenseCode FROM dbo.T_Expense'};
   const snapshot={asOf:'2026-10-19T18:45:00+07:00',recordedAt:new Date().toISOString(),sourceId,queries,data:{}};
   for(const [key,q]of Object.entries(queries))snapshot.data[key]=await sql.executeSqlQuery(q,sourceId);
   write('oracle.private.json',snapshot);
   write('environment.json',{provider:{id:provider.id,model:provider.model,type:provider.type,tokenCost:provider.tokenCost},sourceId,role:'admin',activeTables:h.loadJson('dictionary.json',[]).filter(t=>t.isActive&&t.dbSourceId===sourceId).length,startedAt:new Date().toISOString(),scope:'Fresh sessions; no writes/imports/sends; no restricted-role impersonation. Calendar metrics use ElectricityOutputDate, not PeriodID.'});
  }
 });
 const oracle=read(`${dir}/oracle.private.json`),d=oracle.data;
 const customer=d.customers.find(c=>d.outputs.some(o=>o.CustomerID===c.CustomerID)&&d.contracts.some(t=>t.CustomerID===c.CustomerID));
 const other=d.customers.find(c=>c.CustomerID!==customer.CustomerID&&d.outputs.some(o=>o.CustomerID===c.CustomerID));
 const cs=d.contracts.filter(t=>t.CustomerID===customer.CustomerID),outs=d.outputs.filter(o=>o.CustomerID===customer.CustomerID).sort((a,b)=>a.ElectricityOutputDate.localeCompare(b.ElectricityOutputDate));
 const months=[...new Set(outs.map(o=>o.ElectricityOutputDate.slice(0,7)))],periods=[...new Set(outs.map(o=>o.PeriodID))];
 const params={customerCode:customer.CustomerCode,customerCodeA:customer.CustomerCode,customerCodeB:other.CustomerCode,contractNo:cs[0].ContractNo,contractNoA:cs[0].ContractNo,contractNoB:cs[1].ContractNo,month:months.at(-1),monthA:months[0],monthB:months.at(-1),periodId:periods.at(-1),periodA:periods[0],periodB:periods.at(-1),year:months.at(-1).slice(0,4),yearA:Number(months.at(-1).slice(0,4))-1,yearB:Number(months.at(-1).slice(0,4)),cutoff:'02-28',endMonth:months.at(-1),asOf:'2026-10-19',lotCode:d.lots[0]?.LandLot,emptyMonth:'2026-09',ticketCode:d.tickets[0]?.FeedbackID};
 if(d.outputs.some(o=>o.ElectricityOutputDate.startsWith(params.emptyMonth)))throw Error('emptyMonth not empty');
 const html=fs.readFileSync('docs/BO_TESTCASE_NANG_LUC_AI_IPMS_V2_151026.html','utf8');const suite=JSON.parse(html.match(/id="data">(.*?)<\/script>/s)[1]);
 const blocked={'B-008':'Chưa có file thử và sandbox import được duyệt.','B-009':'Không sửa kỳ khóa trên nguồn thật; chưa có sandbox/kỳ thử.','B-010':'Chưa có SLA/hạn xử lý/lịch làm việc được duyệt.','B-011':'Chưa xác minh lịch bảo trì và hạn hoàn thành.','B-013':'Chưa có stageDays được duyệt và lịch sử thời điểm vào bước.','B-014':'Chưa có nhóm khách hàng và outageWindow được duyệt.','B-015':'Chưa có careDays được duyệt và nguồn chiến dịch.','B-017':'Chưa có tài khoản doanh nghiệp và entitlement thử tương ứng.','B-018':d.vouchers.length||d.receipts.length?null:'Không có phiếu thu/chi thực để chọn voucherCode và nghiệm thu bản in.','B-019':d.receipts.length?null:'Không có khoản thu thực để chọn receiptCode; chưa có nguồn allocation.','B-022':'Chưa có tài khoản lãnh đạo/mobile và catalog báo cáo được duyệt.','B-023':'Chưa có accountId nguồn cùng auth/access/change audit được đối chiếu.','S-001':'Chưa có tài khoản giới hạn nhóm A/B và policy row-level được xác minh.'};
 const materialized=suite.cases.map(c=>({...c,question:c.question.replace(/\{\{(.*?)\}\}/g,(m,k)=>params[k]??m),blockedReason:blocked[c.id]||null}));write('suite.private.json',{version:suite.version,sourceFile:'docs/BO_TESTCASE_NANG_LUC_AI_IPMS_V2_151026.html',params,cases:materialized});
 const seed=historyMode?read(`${dir}/results.private.json`).find(r=>r.id==='Q-005'&&r.result?.reply):null;
 if(historyMode&&!seed)throw Error('History seed not ready');
 const results=fs.existsSync(`${dir}/${resultFile}`)?read(`${dir}/${resultFile}`):[];
 const only=process.argv.find(a=>a.startsWith('--only='))?.slice(7).split(',');
 if(only&&process.argv.includes('--rerun')){
  const archivedPath=`${dir}/superseded-attempts.private.json`,archived=fs.existsSync(archivedPath)?read(archivedPath):[];
  for(let i=results.length-1;i>=0;i--)if(only.includes(results[i].id)){archived.push({...results[i],mode:historyMode?'history':'fresh',supersededReason:'Sửa cutoff 02-29 thành 02-28 để hợp lệ cho cả 2023 và 2024.'});results.splice(i,1);}
  write('superseded-attempts.private.json',archived);
 }
 const pending=materialized.filter(c=>(!only||only.includes(c.id))&&!results.some(r=>r.id===c.id));let next=0;
 const save=()=>write(resultFile,results.sort((a,b)=>materialized.findIndex(c=>c.id===a.id)-materialized.findIndex(c=>c.id===b.id)));
 async function worker(){while(next<pending.length){const c=pending[next++];
  if(c.blockedReason||c.question.includes('{{')){results.push({id:c.id,status:'BLOCKED',reason:c.blockedReason||'Thiếu tham số thật đã xác minh.',question:c.question});save();console.log(JSON.stringify({id:c.id,status:'BLOCKED'}));continue;}
  const started=Date.now(),sessionId='ipms-v2-191026-'+(historyMode?'history-':'')+c.id+'-'+crypto.randomUUID();const record={id:c.id,question:c.question,sessionId,historySeed:seed?.id||null,startedAt:new Date().toISOString()};
  try{const r=await fetch(base+'/api/intelligent-core/chat',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-Request-ID':crypto.randomUUID()},body:JSON.stringify({question:c.question,history:seed?[{role:'user',content:seed.question},{role:'assistant',content:seed.result.reply}]:[],sessionId,providerId:provider.id,dbSourceId:sourceId,webSearch:false,knowledgeSearchEnabled:true}),signal:AbortSignal.timeout(240000)});record.http=r.status;record.result=await r.json();delete record.result.provider;record.status='REVIEW';}catch(e){record.status='FAIL';record.error=e.name+': '+e.message;}
  record.durationMs=Date.now()-started;results.push(record);save();console.log(JSON.stringify({id:c.id,status:record.status,http:record.http,completion:record.result?.completionStatus,ms:record.durationMs,tokens:record.result?.tokenUsage,preview:record.result?.reply?.slice(0,100)}));
 }}
 await Promise.all([worker(),worker()]);
 await storage.run(()=>{const h=require('../src/backend/utils/storage_helper');const histories=h.loadJson('chat_history.json',[]);const ids=new Set(results.map(r=>r.result?.auditId));write(historyMode?'history-audits.private.json':'audits.private.json',histories.filter(h=>ids.has(h.id)));const sessions=new Set(results.map(r=>r.sessionId));write(historyMode?'history-workflows.private.json':'workflows.private.json',h.loadJson('workflow_runs.json',[]).filter(r=>sessions.has(r.conversationId)));});
 console.log('Completed '+results.length+'/'+materialized.length);
 }finally{await storage.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
