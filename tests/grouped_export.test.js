'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {bind}=require('../src/backend/agent/harness/result_grouping');
const {prepare}=require('../src/backend/utils/export_presentation');
const rows=[{Code:'A',GioiTinh:'Nam'},{Code:'B',GioiTinh:'Nữ'},{Code:'C',GioiTinh:'Nam'}];
const metadata={resultGroupBy:['Giới tính'],displayNames:{GioiTinh:'Giới tính',Code:'Mã nhân viên'}};
test('entity-qualified grouping is bound to exact metadata before rendering/export',async()=>{
 const fields=await bind(['giới tính nv'],['Giới tính','Phòng ban'],async(defs,messages)=>{
  assert.deepEqual(JSON.parse(messages.at(-1).content).requested,['giới tính nv']);
  return {content:'{"fields":["Giới tính"]}'};
 },'phân loại theo giới tính nv và gửi cho tôi ds 2 loại trên có xuất file');
 assert.deepEqual(fields,['Giới tính']);
 await assert.rejects(bind(['unknown'],['Giới tính'],async()=>({content:'{"fields":["invented"]}'})),/UNRESOLVED/);
 await assert.rejects(bind(['unknown'],['Giới tính'],async()=>({content:'{"fields":[]}'})),/UNRESOLVED/);
});
test('grouped XLSX round-trip has separate labeled sheets with all rows',async()=>{
 const {ExportDataTool}=require('../src/backend/agent/tools/builtins');
 const result=await new ExportDataTool().run({data:rows,format:'xlsx',filename:'grouped_export_regression'}, {verifiedExport:metadata});
 const path=require('node:path'),XLSX=require('xlsx');
 const workbook=XLSX.readFile(path.join(require('../src/backend/utils/export_paths').getExportsDirectory(),result.fileName));
 assert.deepEqual(workbook.SheetNames,['Nam','Nữ']);
 const male=XLSX.utils.sheet_to_json(workbook.Sheets.Nam),female=XLSX.utils.sheet_to_json(workbook.Sheets['Nữ']);
 assert.equal(male.length,2);assert.equal(female.length,1);
 assert.deepEqual(Object.keys(male[0]),['Mã nhân viên','Giới tính']);
 assert.equal(male[1]['Mã nhân viên'],'C');assert.equal(female[0]['Mã nhân viên'],'B');
 assert.equal(result.recordCount,3);
 await assert.rejects(new ExportDataTool().run({data:rows,format:'xlsx'}, {verifiedExport:{...metadata,resultGroupBy:['unknown']}}),/UNRESOLVED/);
});
test('sheet names and display headers remain unique after sanitization',()=>{
 const result=prepare([{a:1,b:'A/B'},{a:2,b:'A:B'},{a:3,b:null}],{resultGroupBy:['b'],displayNames:{a:'X',b:'X'}});
 assert.deepEqual(result.groups.map(g=>g.name),['A B','A B (2)','Chưa xác định']);
 assert.deepEqual(Object.keys(result.data[0]),['X','X (2)']);
 assert.deepEqual(prepare(rows,{}).data,rows);
});
test('harness passes verified full rows and grouping to export and renders separate groups',async()=>{
 const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
 const BaseTool=require('../src/backend/agent/tools/base_tool');
 const Manager=require('../src/backend/agent/tools/tool_manager');
 const {ExportDataTool}=require('../src/backend/agent/tools/builtins');
 const manager=new Manager();
 const sql='SELECT Code, GioiTinh FROM Employees';
 const sqlTool=new BaseTool({name:'execute_sql_query',description:'fixture query',parameters:{type:'object',properties:{sql:{type:'string'}},required:['sql']}});
 sqlTool.run=async()=>({rows,sql,displayNames:metadata.displayNames});manager.registerTool(sqlTool);
 const exportTool=new ExportDataTool(),original=exportTool.run.bind(exportTool);
 exportTool.run=async(args,context)=>{assert.equal(args.data.length,3);assert.deepEqual(context.verifiedExport,metadata);return original({...args,filename:'grouped_harness_regression'},context);};manager.registerTool(exportTool);
 let calls=0;
 const harness=new Harness({toolManager:manager,dispatch:async()=>{
  if(calls++===0)return {tool_calls:[{id:'q',type:'function',function:{name:'execute_sql_query',arguments:JSON.stringify({sql})}},{id:'e',type:'function',function:{name:'export_data',arguments:JSON.stringify({format:'xlsx',data:rows.slice(0,1)})}}]};
  return {content:'Đã xuất danh sách.'};
 }});
 const result=await harness.run({userMessage:'Separate employee lists by gender and export',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['execute_sql_query','export_data'],context:{lockProvider:true,mode:'data',requestPlan:{intent:'list',table:'Employees',schemaColumns:['Code','GioiTinh'],resultGroupBy:metadata.resultGroupBy,outputs:{data:true,export:true}}}});
 assert.equal(result.trace.completionStatus,'SUCCESS');assert.match(result.replyText,/\*\*Nam \(2\)\*\*/);assert.match(result.replyText,/\*\*Nữ \(1\)\*\*/);
 const exported=result.toolCalls.find(c=>c.toolName==='export_data');assert.equal(exported.success,true);assert.deepEqual(exported.result.groups.map(g=>g.rowCount),[2,1]);
});
