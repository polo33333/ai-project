'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

function uiFixture() {
 const fields=new Map(Object.entries({'relationship-id':'relation-1','relationship-revision':'1','target-table':'target',cardinality:'many-to-one','business-role':'','display-column':'',preferred:'','pair-source':'EmployeeID','pair-target':'EmployeeID'})
  .map(([role,value])=>[role,{value,dataset:{role},type:role==='preferred'?'checkbox':'text',checked:false}]));
 const field=selector=>[...fields].find(([role])=>selector.includes(`[data-role="${role}"]`))?.[1] || null;
 const editor={dataset:{column:'EmployeeID'},hidden:false,querySelector:field,
  querySelectorAll:selector=>selector==='.dictionary-relation-pair'?[{querySelector:field}]:[...fields.values()],closest:()=>null};
 const source={tableId:'source',tableName:'Invoices',columns:[{columnName:'EmployeeID',dataType:'INT'}]};
 const target={tableId:'target',tableName:'Employees',columns:[{columnName:'EmployeeID',dataType:'INT',isPrimaryKey:true},{columnName:'EmployeeName',dataType:'NVARCHAR'}]};
 const relation={id:'relation-1',sourceTableId:'source',targetTableId:'target',sourceTable:'Invoices',targetTable:'Employees',revision:1,status:'suggested',cardinality:'many-to-one',columnPairs:[{sourceColumn:'EmployeeID',targetColumn:'EmployeeID'}],displayColumn:''};
 const c={window:{},document:{addEventListener(){},getElementById:()=>null,querySelectorAll:selector=>selector.includes('.dictionary-field-relation-editor')?[editor]:[]},console,showToast(){}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/dictionary.js','utf8'),c);
 Object.assign(c.window,{groupedTablesData:[source,target],tableRelationshipsData:[relation],selectedDictionaryTableId:'source',selectedDictionaryTableName:'Invoices'});
 c.renderDictionaryQuality=()=>{};c.renderDataDictionary=()=>{};c.renderDictionaryDrawer=()=>{};c.window.refreshDictionarySyncStatus=()=>{};
 editor.dataset.initialState=c.readFieldRelationshipState(editor);
 return {c,fields,editor,source,target,relation};
}

test('Save all captures the selected display column without the separate stage button and survives backend reload',async()=>{
 const {c,fields,source,target,relation}=uiFixture();
 const {DictionaryService}=require('../src/backend/services/dictionary_service');
 const d=new DictionaryService();d.tablesStore=[source,target];d.tableRelationships=[relation];d.persist=()=>{};d.syncToQdrant=async()=>({success:true});
 let payload,openedDisplay;
 c.fetch=async(url,options)=>{payload=JSON.parse(options.body);const result=await d.saveTableConfiguration(payload);return {ok:true,json:async()=>({status:'success',...result})};};
 c.renderDictionaryDrawer=()=>{openedDisplay=c.window.tableRelationshipsData.find(r=>r.id===relation.id).displayColumn;};
 fields.get('display-column').value='EmployeeName';
 await c.saveSelectedTableDescription();
 assert.equal(payload.relationships.length,1);
 assert.equal(payload.relationships[0].payload.displayColumn,'EmployeeName');
 assert.equal(d.tableRelationships[0].displayColumn,'EmployeeName');
 const reloaded=d.normalizeRelationship(JSON.parse(JSON.stringify(d.tableRelationships[0])));
 assert.equal(reloaded.displayColumn,'EmployeeName');assert.equal(openedDisplay,'EmployeeName');
});

test('unchanged editors are not saved and an explicit clear of display column is submitted',()=>{
 const {c,fields}=uiFixture();
 assert.equal(c.stageDirtyFieldRelationships(),true);assert.equal(c.window.pendingDictionaryRelationships?.length||0,0);
 fields.get('display-column').value='EmployeeName';c.stageDirtyFieldRelationships();
 assert.equal(c.window.pendingDictionaryRelationships[0].payload.displayColumn,'EmployeeName');
 fields.get('display-column').value='';c.stageDirtyFieldRelationships();
 assert.equal(c.window.pendingDictionaryRelationships.length,1);
 assert.equal(c.window.pendingDictionaryRelationships[0].payload.displayColumn,'');
});

test('stage button preserves unrelated unsaved form inputs without rebuilding the drawer',()=>{
 const {c,fields}=uiFixture();let rendered=0;c.renderDictionaryDrawer=()=>rendered++;
 fields.get('display-column').value='EmployeeName';
 assert.equal(c.saveFieldRelationship('EmployeeID'),true);
 assert.equal(rendered,0);assert.equal(c.window.pendingDictionaryRelationships[0].payload.displayColumn,'EmployeeName');
});

test('verify shows progress immediately, prevents duplicate requests and restores the button after failure',async()=>{
 const {c}=uiFixture();let calls=0,finish;
 const attributes=new Map([['aria-label','Xác minh quan hệ']]),classes=new Set();
 const button={disabled:false,innerHTML:'<i class="fa-solid fa-check"></i>',title:'Xác minh',
  classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)},
  setAttribute:(name,value)=>attributes.set(name,value),getAttribute:name=>attributes.get(name)??null,removeAttribute:name=>attributes.delete(name)};
 c.fetch=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 c.fetchDataDictionary=async()=>{};
 const request=c.setFieldRelationshipStatus('relation-1','verified',button);
 assert.equal(button.disabled,true);assert.match(button.innerHTML,/Đang xác minh/);assert.equal(attributes.get('aria-busy'),'true');
 await c.setFieldRelationshipStatus('relation-1','verified',button);assert.equal(calls,1);
 finish({ok:false,status:400,json:async()=>({status:'error',message:'Cần kiểm tra dữ liệu'})});await request;
 assert.equal(button.disabled,false);assert.equal(button.title,'Xác minh');assert.equal(attributes.has('aria-busy'),false);assert.equal(classes.has('is-processing'),false);
 assert.match(button.innerHTML,/fa-check/);
 const retry=c.setFieldRelationshipStatus('relation-1','verified',button);assert.equal(calls,2);
 finish({ok:true,json:async()=>({status:'success',relationships:[{id:'relation-1',status:'verified'}]})});await retry;
 assert.equal(button.disabled,false);assert.equal(c.window.tableRelationshipsData[0].status,'verified');
});
