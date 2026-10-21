'use strict';
const fs=require('fs');
const configs={
 M_Company:{entity:'Đơn vị (M_Company)',grain:'Một bản ghi đơn vị, định danh bởi CompanyID; chưa xác minh vai trò đơn vị quản lý hay khách hàng',identityFields:['CompanyID'],summaryFields:['CompanyID','CompanyCode','CompanyName'],aliases:[],segments:[]},
 M_Constant:{entity:'Danh mục dùng chung',grain:'Một giá trị danh mục, định danh bởi ConstantID; loại danh mục theo ConstantType',identityFields:['ConstantID'],summaryFields:['ConstantID','ConstantType','ConstantName'],aliases:[],segments:[]},
 M_Customer:{entity:'Khách hàng',grain:'Một khách hàng, định danh bởi CustomerID',identityFields:['CustomerID'],summaryFields:['CustomerID','CustomerCode','CustomerName'],aliases:['khách hàng','doanh nghiệp'],segments:[]},
 M_Employee:{entity:'Nhân viên',grain:'Một nhân viên, định danh bởi EmployeeID',identityFields:['EmployeeID'],summaryFields:['EmployeeID','EmployeeCode','EmployeeName'],aliases:['nhân viên'],segments:[]},
 M_Master:{entity:'Danh mục M_Master',grain:'Một mục danh mục, định danh bởi MasterID; ý nghĩa phụ thuộc MasterType và vai trò quan hệ',identityFields:['MasterID'],summaryFields:['MasterID','Code','Name','MasterType'],aliases:[],segments:[]},
 S_User:{entity:'Tài khoản hệ thống',grain:'Một tài khoản, định danh bởi UserID; nhân viên liên kết qua EmployeeID',identityFields:['UserID'],summaryFields:['UserID','UserName','UserDesc'],aliases:['tài khoản người dùng'],segments:[]},
 T_Contract:{entity:'Hợp đồng',grain:'Một hợp đồng, định danh bởi ContractID',identityFields:['ContractID'],summaryFields:['ContractID','ContractNo','ContractDate'],aliases:['hợp đồng'],segments:[]},
 T_ElectricityInput:{entity:'Chứng từ điện đầu vào',grain:'Một chứng từ điện đầu vào, định danh bởi ElectricityInputID',identityFields:['ElectricityInputID'],summaryFields:['ElectricityInputID','ElectricityInputCode','ElectricityInputDate'],aliases:['điện đầu vào'],segments:[]},
 T_ElectricityOutput:{entity:'Chứng từ điện bán ra',grain:'Một chứng từ điện bán ra, định danh bởi ElectricityOutputID; không phải một dòng phí chi tiết',identityFields:['ElectricityOutputID'],summaryFields:['ElectricityOutputID','ElectricityOutputCode','ElectricityOutputDate'],aliases:['điện bán ra'],segments:[]},
 T_ElectricityOutputDetail:{entity:'Chi tiết điện bán ra và khoản phí',grain:'Một dòng chi tiết, định danh bởi ElectricityOutputDetailID; nhiều dòng có thể thuộc một ElectricityOutputID',identityFields:['ElectricityOutputDetailID'],summaryFields:['ElectricityOutputDetailID','ElectricityOutputID','HoUID','FinalAmount'],aliases:['phí vận hành','duy tu cơ sở hạ tầng'],segments:[]}
};
async function main(){
 const credentials=JSON.parse(fs.readFileSync(0,'utf8')),b='http://localhost:5500';
 let r=await fetch(b+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});if(!r.ok)throw Error('login');
 const headers={'Content-Type':'application/json',Cookie:r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')};
 const request=async(path,body)=>{const r=await fetch(b+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(path+': '+(data.message||r.status));return data};
 const report={startedAt:new Date().toISOString(),tables:[],relationships:[],unresolved:['M_Company: chưa xác minh vai trò đơn vị quản lý/khách hàng','Đơn vị tiền, quy tắc thuế và ý nghĩa các mã category ngoài mapping đã cấu hình cần bằng chứng nghiệp vụ.']};
 const save=()=>fs.writeFileSync('artifacts/semantic-model/deployment.json',JSON.stringify(report,null,2));
 try{
  const tables=await request('/api/dictionary'),rels=await request('/api/dictionary/relationships');
  if(process.argv.includes('--domains')) {
   const domains=await request('/api/dictionary/domains');
   fs.writeFileSync('artifacts/semantic-model/domains-before.private.json',JSON.stringify(domains,null,2));
   for(const [domain,aliases]of Object.entries({organization:['đơn vị quản lý','đơn vị vận hành'],reference:['danh mục dùng chung'],identity:['tài khoản hệ thống']})) {
    await request('/api/dictionary/domains/save',{domain,aliases:[...new Set([...(domains[domain]||[]),...aliases])]});
   }
   const mapping={M_Company:'organization',M_Constant:'reference',M_Master:'reference',S_User:'identity',T_ElectricityInput:'electricity',T_ElectricityOutputDetail:'electricity'},applied=[];
   for(const t of tables.filter(t=>t.isActive&&t.dbSourceId==='db-src-1785684548077'&&!t.domain&&mapping[t.tableName])) {
    await request('/api/dictionary/save-table-configuration',{tableId:t.tableId,table:{domain:mapping[t.tableName]},columns:[],relationships:[]});applied.push({table:t.tableName,domain:mapping[t.tableName]});
   }
   fs.writeFileSync('artifacts/semantic-model/domain-configuration.json',JSON.stringify({applied},null,2));console.log(JSON.stringify(applied));return;
  }
  if(process.argv.includes('--confirmed-business')) {
   const money={T_ElectricityOutputDetail:['Price','PreAmount','VATAmount','FinalAmount'],T_ElectricityOutput:['PowerMoney','VATPowerMoney','FinalPowerMoney','PreTotalAmount','VATTotalAmount','FinalTotalAmount','OpeningBalance_Debit','CurrentPeriodAmount_LPInterest','CurrentPeriodAmount_LPPenalty','ClosingBalance_Debit'],T_ElectricityInput:['PreTotalAmount','VATTotalAmount','FinalTotalAmount']};
   const applied=[];
   for(const t of tables.filter(t=>t.isActive&&t.dbSourceId==='db-src-1785684548077'&&t.semanticModel)) {
    const semanticModel={...t.semanticModel,defaultCurrency:'VNĐ',monetaryFields:(money[t.tableName]||[]).filter(name=>t.columns.some(c=>c.columnName===name&&c.isVisible!==false))};
    const table={semanticModel};
    if(t.tableName==='M_Company') {
     Object.assign(semanticModel,{entity:'Đơn vị quản lý/vận hành',grain:'Một đơn vị quản lý/vận hành, định danh bởi CompanyID',aliases:['đơn vị quản lý','đơn vị vận hành']});
     table.description='Thông tin đơn vị quản lý/vận hành trong khu công nghiệp. M_Company không phải danh sách doanh nghiệp khách hàng; khách hàng được quản lý trong M_Customer.';
    }
    await request('/api/dictionary/save-table-configuration',{tableId:t.tableId,table,columns:[],relationships:[]});applied.push({table:t.tableName,currency:semanticModel.defaultCurrency,monetaryFields:semanticModel.monetaryFields});
   }
   fs.writeFileSync('artifacts/semantic-model/business-confirmation.json',JSON.stringify({confirmedBy:'user',applied,unresolved:['Mã HoUID cho duy tu cơ sở hạ tầng chưa được xác nhận. Không tự gán mã 21 cho nhóm này.']},null,2));
   console.log('Applied user-confirmed company role and configurable currency default');return;
  }
  if(process.argv.includes('--kinds-only')) {
   for(const t of tables.filter(t=>t.isActive&&t.dbSourceId==='db-src-1785684548077'&&t.semanticModel)) {
    const kind=t.tableName.startsWith('T_')?(t.tableName.endsWith('Detail')?'detail':'transaction'):['M_Constant','M_Master'].includes(t.tableName)?'lookup':'entity';
    await request('/api/dictionary/save-table-configuration',{tableId:t.tableId,table:{semanticModel:{...t.semanticModel,kind}},columns:[],relationships:[]});
   }
   console.log('Updated table roles');return;
  }
  fs.mkdirSync('artifacts/semantic-model',{recursive:true});
  if(!fs.existsSync('artifacts/semantic-model/deploy-backup.private.json'))fs.writeFileSync('artifacts/semantic-model/deploy-backup.private.json',JSON.stringify({tables,relationships:rels},null,2));
  for(const t of tables.filter(t=>t.isActive&&configs[t.tableName])){
   // Restrict deployment to the reviewed IPMS source, never same-named tables elsewhere.
   if(t.dbSourceId!=='db-src-1785684548077')continue;
   const kind=t.tableName.startsWith('T_')?(t.tableName.endsWith('Detail')?'detail':'transaction'):['M_Constant','M_Master'].includes(t.tableName)?'lookup':'entity';
   const semanticModel={version:1,kind,...structuredClone(configs[t.tableName])};
   if(t.tableName==='T_ElectricityOutputDetail'){
    const ho=t.columns.find(c=>c.columnName==='HoUID');
    // Exact existing user-authored mapping: no heuristic extraction or inferred IDs.
    if(ho?.description?.includes('chi phí vận hành với id = 21'))semanticModel.segments=[{id:'chi_phi_van_hanh',label:'Chi phí vận hành',column:'HoUID',value:21}];
    else report.unresolved.push('HoUID: chưa chuyển mapping sang cấu trúc vì mô tả khác snapshot đã duyệt.');
   }
   require('../src/backend/services/semantic_model').validateModel(semanticModel,t);
   const description=t.tableName==='M_Company'?'Thông tin đơn vị trong M_Company. Vai trò đơn vị quản lý hay khách hàng chưa được xác minh; không thay thế M_Customer.':t.tableDescription;
   await request('/api/dictionary/save-table-configuration',{tableId:t.tableId,table:{semanticModel,description},columns:[],relationships:[]});
   report.tables.push({table:t.tableName,configured:true,segmentCount:semanticModel.segments.length});save();
  }
  const targets=[['T_ElectricityOutputDetail','T_ElectricityOutput','Chứng từ điện bán ra','ElectricityOutputCode'],['T_ElectricityOutput','M_Customer','Khách hàng','CustomerName'],['S_User','M_Employee','Nhân viên','EmployeeName']];
  for(const [from,to,role,display] of targets){
   const candidates=rels.filter(r=>r.sourceTable===from&&r.targetTable===to&&r.isActive!==false&&r.sourceTableId?.startsWith('db-src-1785684548077::'));
   if(candidates.length!==1){report.relationships.push({from,to,status:'unresolved',reason:'missing or ambiguous relationship'});continue;}
   let relation=candidates[0];
   try{
    relation=(await request('/api/dictionary/relationships/profile',{id:relation.id,expectedRevision:relation.revision})).relationship;
    const profile=relation.evidence?.profile;
    if(!profile||profile.totalRows===0||profile.orphanRows!==0||profile.duplicateTargetKeys!==0) {report.relationships.push({from,to,status:'unresolved',profile});save();continue;}
    relation=(await request('/api/dictionary/relationships/update',{id:relation.id,expectedRevision:relation.revision,businessRole:role,displayColumn:display})).relationship;
    relation=(await request('/api/dictionary/relationships/status',{id:relation.id,expectedRevision:relation.revision,status:'verified'})).relationship;
    report.relationships.push({from,to,status:relation.status,profile});
   }catch(error){report.relationships.push({from,to,status:'unresolved',reason:error.message});}
   save();
  }
  report.completedAt=new Date().toISOString();save();console.log(JSON.stringify(report));
 }finally{await fetch(b+'/api/auth/logout',{method:'POST',headers})}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
