'use strict';
const storage=require('../src/backend/storage'); storage.loadEnvironment();
(async()=>{
 await storage.bootstrapStorage();
 try { await storage.run(async()=>{
  const dictionary=require('../src/backend/services/dictionary_service');
  const tables=dictionary.tablesStore.filter(t=>t.tableName==='T_Contract' && t.isActive!==false);
  if(tables.length!==1) throw new Error('Cần đúng một bảng hợp đồng đang bật.');
  const table=tables[0], mapped=require('../src/backend/automation/column_mapping').buildSelect(table,dictionary);
  if(!table.columns.some(c=>c.columnName==='ContractNo' && c.isVisible!==false)) throw new Error('Cột số hợp đồng chưa bật.');
  const like="LIKE CONCAT('%', REPLACE(REPLACE(REPLACE(@query, '[', '[[]'), '%', '[%]'), '_', '[_]'), '%')";
  const customerIndex=mapped.resultMapping.findIndex(m=>m.columnName==='CustomerID' && m.relationId);
  const customerRelation=customerIndex>=0 && dictionary.tableRelationships.find(r=>r.id===mapped.resultMapping[customerIndex].relationId);
  const quote=v=>'['+v.replace(/]/g,']]')+']';
  const where=`e.[ContractNo] ${like}`+(customerRelation?` OR r${customerIndex}.${quote(customerRelation.displayColumn)} ${like}`:'');
  const expected=rows=>({contracts:rows,count:rows.length,empty:rows.length===0});
  const sample={ContractNo:'TEST_HD001',CustomerID:'Khách hàng thử nghiệm'};
  const template={id:'contract_details',name:'Tra cứu thông tin hợp đồng',enabled:true,description:'Tra cứu hồ sơ hợp đồng theo số hợp đồng'+(customerRelation?' hoặc tên khách hàng':'')+'. Trả tối đa 50 kết quả với các cột hiển thị và quan hệ đã xác minh.',examples:['Tra cứu thông tin hợp đồng','Xem chi tiết hợp đồng số TEST_HD001','Tra cứu hợp đồng của khách hàng'],instructions:'Chọn mẫu cho yêu cầu tra cứu hợp đồng. Tách số hợp đồng hoặc tên khách hàng được nêu rõ vào query, không lấy toàn bộ câu yêu cầu làm giá trị. Nếu chưa có điều kiện, hỏi bổ sung. Không suy đoán dữ liệu, không chuyển yêu cầu nhân viên sang mẫu này. Nếu nhiều kết quả, hiển thị tất cả và đề nghị số hợp đồng cụ thể để thu hẹp.',inputs:{query:{label:'Số hợp đồng hoặc tên khách hàng',ask:customerRelation?'Bạn muốn tra cứu số hợp đồng nào hoặc hợp đồng của khách hàng nào?':'Bạn muốn tra cứu số hợp đồng nào?',required:true,schema:{type:'string',minLength:1,maxLength:100}}},allowedCapabilities:['sql.read'],bindings:{contract:{dbSourceId:table.dbSourceId,tables:mapped.tables,resultMapping:mapped.resultMapping,sql:mapped.select+` WHERE ${where} ORDER BY e.[ContractNo], e.[ContractID]`,parameters:{query:{slot:'query',type:'string'}}}},workflow:{steps:[{id:'lookup',name:'Tìm hợp đồng theo điều kiện tra cứu',type:'sql',config:{bindingRef:'contract'}}]},output:{mapping:{contracts:'{{steps.lookup.rows}}',count:'{{steps.lookup.rowCount}}',empty:'{{steps.lookup.empty}}'},schema:{type:'object',properties:{contracts:{type:'array',items:{type:'object',properties:{},additionalProperties:true}},count:{type:'integer'},empty:{type:'boolean'}},required:['contracts','count','empty'],additionalProperties:false},presentation:{labels:{contracts:'Thông tin hợp đồng',count:'Số hợp đồng tìm thấy',...Object.fromEntries(mapped.resultMapping.map(m=>[`contracts.${m.key}`,m.label]))},emptyText:'Không tìm thấy hợp đồng phù hợp. Hãy kiểm tra số hợp đồng hoặc tên khách hàng.'}},fixtures:[{name:'Tra cứu số hợp đồng',input:{query:'TEST_HD001'},stepResults:{lookup:{rows:[sample],rowCount:1,empty:false}},expected:expected([sample])},{name:'Nhiều hợp đồng của khách hàng',input:{query:'Khách hàng thử nghiệm'},stepResults:{lookup:{rows:[sample,{...sample,ContractNo:'TEST_HD002'}],rowCount:2,empty:false}},expected:expected([sample,{...sample,ContractNo:'TEST_HD002'}])},{name:'Không tìm thấy',input:{query:'TEST_NOT_FOUND'},stepResults:{lookup:{rows:[],rowCount:0,empty:true}},expected:expected([])}]};
  const automation=require('../src/backend/automation'), previous=await automation.repository.get('catalog','contract_lookup');
  if(previous) throw new Error('Mẫu hợp đồng đã tồn tại; không ghi đè.');
  const bundle={manifest:{id:'contract_lookup',name:template.name,version:1,engineContractVersion:1,domain:'Hợp đồng',tags:['hợp đồng','tra cứu','khách hàng']},templates:[template]};
  require('../src/backend/automation/contract').validatePackage(bundle);
  const smoke=await require('../src/backend/automation/sql').executeBinding(template.bindings.contract,{query:'TEST_CONTRACT_LOOKUP_NO_MATCH_20260926'},{permissions:['admin'],signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({columns:mapped.resultMapping.length,relations:mapped.resultMapping.filter(m=>m.relationId).map(m=>m.label),smokeRows:smoke.rowCount}));
  const fs=require('node:fs'),path=require('node:path'); fs.writeFileSync(path.join(__dirname,'../docs/templates/contract_lookup.json'),JSON.stringify(bundle,null,2)+'\n');
  if(process.argv.includes('--install')) { const context={accountId:'local-template-setup',permissions:['admin']}; await automation.registry.import(bundle,context); const report=await automation.registry.test('contract_lookup',context); if(!report.passed) throw new Error('Fixture không đạt.'); const record=await automation.repository.get('catalog','contract_lookup'); await automation.registry.publish(record.id,context,record.revision); console.log('Published contract_lookup v1; feature settings unchanged.'); }
 }); } finally { await storage.close(); }
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
