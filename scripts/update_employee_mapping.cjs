'use strict';
const storage = require('../src/backend/storage'); storage.loadEnvironment();
(async () => {
 await storage.bootstrapStorage();
 try { await storage.run(async () => {
  const dictionary = require('../src/backend/services/dictionary_service');
  const table = dictionary.tablesStore.find(t => t.tableName === 'M_Employee');
  const automation = require('../src/backend/automation');
  const record = await automation.repository.get('catalog','employee_lookup');
  if (!table || !record) throw new Error('Không tìm thấy bảng hoặc mẫu nhân viên.');
  const bundle = structuredClone(record.draft);
  const template = bundle.templates.find(t=>t.id==='employee_details');
  const mapped = require('../src/backend/automation/column_mapping').buildSelect(table,dictionary);
  const binding = template.bindings.employee;
  binding.sql = mapped.select + " WHERE e.[EmployeeCode] = @query OR e.[EmployeeName] LIKE CONCAT('%', REPLACE(REPLACE(REPLACE(@query, '[', '[[]'), '%', '[%]'), '_', '[_]'), '%') ORDER BY e.[EmployeeCode], e.[EmployeeID]";
  binding.tables = mapped.tables; binding.resultMapping = mapped.resultMapping;
  bundle.manifest.version = Math.max(bundle.manifest.version,...(record.versions||[]).map(v=>v.manifest.version))+1;
  for(const m of mapped.resultMapping) template.output.presentation.labels[`employees.${m.key}`]=m.label;
  require('../src/backend/automation/contract').validatePackage(bundle);
  const smoke = await require('../src/backend/automation/sql').executeBinding(binding,{query:'TEST_MAPPING_NO_MATCH_20260926'},{permissions:['admin'],signal:AbortSignal.timeout(15000)});
  console.log(JSON.stringify({columns:mapped.resultMapping.map(m=>({key:m.key,label:m.label,relation:!!m.relationId})),tables:mapped.tables,smokeRows:smoke.rowCount}));
  if(process.argv.includes('--apply')) {
   const context={accountId:'local-template-setup',permissions:['admin']};
   await automation.registry.import(bundle,context,record.revision);
   const report=await automation.registry.test(record.id,context); if(!report.passed) throw new Error('Fixture không đạt.');
   const current=await automation.repository.get('catalog',record.id); await automation.registry.publish(record.id,context,current.revision);
   const fs=require('node:fs'),path=require('node:path'); fs.writeFileSync(path.join(__dirname,'../docs/templates/employee_lookup.json'),JSON.stringify(bundle,null,2)+'\n');
   console.log('Published employee mapping version '+bundle.manifest.version);
  }
 }); } finally { await storage.close(); }
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
