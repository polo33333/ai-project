'use strict';
const fs=require('node:fs');
const storage=require('../src/backend/storage');storage.loadEnvironment();
const sourceId='db-src-1785684548077';
async function main(){
 await storage.bootstrapStorage();const report=[];
 try{
  await storage.run(async()=>{
   const d=require('../src/backend/services/dictionary_service');
   const tables=d.tablesStore.filter(t=>t.dbSourceId===sourceId&&t.isActive);
   const targets={CustomerID:['M_Customer','Khách hàng','CustomerName'],ContractID:['T_Contract','Hợp đồng','ContractNo'],VendorID:['M_Vendor','Nhà cung cấp','VendorName'],RevenueID:['T_Revenue','Phiếu thu','RevenueCode'],ExpenseID:['T_Expense','Phiếu chi','ExpenseCode'],FeedbackID:['T_Feedback','Yêu cầu khách hàng','Title'],InfrastructureID:['T_Infrastructure','Tài sản hạ tầng','InfrastructureName'],LightID:['T_Light','Thiết bị đèn','LightName'],LandTaskForRentID:['T_LandTaskForRent','Lô đất','LandLot']};
   for(const t of tables)for(const [key,[targetName,role,display]] of Object.entries(targets)){
    const col=t.columns.find(c=>c.columnName===key&&c.isVisible!==false);
    const target=tables.find(t=>t.tableName===targetName);
    if(!col||!target||target===t||col.isPrimaryKey)continue;
    let r=d.tableRelationships.find(r=>r.sourceTableId===t.tableId&&r.targetTableId===target.tableId&&r.columnPairs?.length===1&&r.columnPairs[0].sourceColumn===key&&r.columnPairs[0].targetColumn===key);
    if(r&&['verified','rejected','stale'].includes(r.status))continue;
    try{
     if(!r)r=await d.addTableRelationship({sourceTableId:t.tableId,targetTableId:target.tableId,columnPairs:[{sourceColumn:key,targetColumn:key}],cardinality:'many-to-one',businessRole:role,displayColumn:display});
     r=await d.profileTableRelationship(r.id,r.revision);
     const p=r.evidence.profile;
     if(p.totalRows>p.nullKeyRows&&p.orphanRows===0&&p.duplicateTargetKeys===0)r=await d.setTableRelationshipStatus(r.id,'verified',r.revision,'user-authorized-ipms-testcase-catalog');
     report.push({from:t.tableName,to:targetName,status:r.status,profile:p});
    }catch(e){report.push({from:t.tableName,to:targetName,error:e.code||e.message});}
   }
  });
  await storage.run(async()=>{
   const d=require('../src/backend/services/dictionary_service');
   const sql=require('../src/backend/services/sql_connector');
   const smoke=[];
   for(const name of ['M_Price','T_Revenue','T_LandTaskForRent','T_Feedback']){
    const rows=await sql.executeSqlQuery(`SELECT COUNT_BIG(*) AS [record_count] FROM [dbo].[${name}]`,sourceId);smoke.push({table:name,rowCount:Number(rows[0].record_count)});
   }
   const result={relationships:report,verifiedRelationships:d.tableRelationships.filter(r=>r.status==='verified'&&r.sourceTableId?.startsWith(sourceId+'::')).map(r=>({from:r.sourceTable,to:r.targetTable,profile:r.evidence?.profile})),smoke,sync:await d.syncToQdrant({defer:false})};
   fs.writeFileSync('artifacts/ipms-testcase-catalog/joins-verification.json',JSON.stringify(result,null,2));
   console.log(JSON.stringify(result));
  });
 }finally{await storage.close()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
