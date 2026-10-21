'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const storage=require('../src/backend/storage');storage.loadEnvironment();
async function main(){
 await storage.bootstrapStorage();
 try{await storage.run(async()=>{
  const log=require('../src/backend/services/logger_service').chatHistory.find(x=>x.id==='8f448e9c-676e-4f49-82a8-9ee84b2d4f36');assert.ok(log);
  const evidence=Object.values(log.requestPayload.evidencePayloads).find(e=>e.rows);
  const provider=require('../src/backend/services/ai_provider_manager').getProviderForExecution(log.requestPayload.providerId);
  const dispatch=(defs,messages)=>require('../src/backend/intelligent_core/adapters').dispatchToProvider({...provider,temperature:0.1},messages,defs,AbortSignal.timeout(45000));
  const fields=await require('../src/backend/agent_core/harness/result_grouping').bind(['giới tính nv'],Object.values(evidence.displayNames),dispatch,log.question);
  assert.deepEqual(fields,['Giới tính']);
  const rendered=require('../src/backend/agent_core/harness/grounded_reply').buildSqlRowsFallbackReply({result:evidence},{},{resultGroupBy:fields});
  assert.match(rendered,/\*\*Nam \(7\)\*\*/);assert.match(rendered,/\*\*Nữ \(2\)\*\*/);
  const result=await new(require('../src/backend/agent_core/tools/builtins').ExportDataTool)().run({data:evidence.rows,format:'xlsx',filename:'Danh_sach_nhan_vien_tach_nhom_da_sua'}, {verifiedExport:{displayNames:evidence.displayNames,resultGroupBy:fields}});
  const file=path.join(require('../src/backend/utils/export_paths').getExportsDirectory(),result.fileName),XLSX=require('xlsx'),book=XLSX.readFile(file);
  assert.deepEqual(book.SheetNames,['Nam','Nữ']);
  for(const [name,count]of [['Nam',7],['Nữ',2]]) {
   const rows=XLSX.utils.sheet_to_json(book.Sheets[name]);assert.equal(rows.length,count);
   assert.ok(rows.every(row=>row['Giới tính']===name));
  }
  fs.mkdirSync('artifacts/grouped-export',{recursive:true});
  fs.writeFileSync('artifacts/grouped-export/verification.json',JSON.stringify({fields,rendered,result,file,verified:true},null,2));
  console.log(JSON.stringify({fields,file,sheets:book.SheetNames,groups:result.groups,verified:true}));
 });}finally{await storage.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
