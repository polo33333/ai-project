'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
function setup() {
 const source=fs.readFileSync('src/frontend/js/modules/dictionary.js','utf8');
 const elements=new Map();
 for(const id of ['summary','results','search','kind','table','count','page','prev','next']) elements.set('dictionary-quality-'+id,{value:id==='kind'?'all':'',innerHTML:'',textContent:'',contains:()=>true});
 const tables=[{tableId:'source',tableName:'Orders',semanticModel:{entity:'Đơn hàng'},columns:[{columnName:'CustomerID'}]},
 {tableId:'target',tableName:'Customers',semanticModel:{entity:'Khách hàng'},columns:[{columnName:'ID'}]}];
 const relations=[{id:'internal-uuid',sourceTableId:'source',targetTableId:'target',status:'suggested',cardinality:'many-to-one',businessRole:'Khách hàng mua',columnPairs:[{sourceColumn:'CustomerID',targetColumn:'ID'}]}];
 const issue={field:'relationships.internal-uuid',code:'RELATIONSHIP_UNVERIFIED',severity:'warning',message:'Chưa xác minh'};
 const quality={activeTables:2,tables:tables.map(t=>({...t,issues:[issue]}))};
 const context={window:{tableRelationshipsData:relations},document:{getElementById:id=>elements.get(id)},getDictionaryTables:()=>tables};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function escapeDictHtml'),source.indexOf('function getDictionaryTables')),context);
 vm.runInContext(source.slice(source.indexOf('const dictionaryQualityState'),source.indexOf('function renderDictionaryDomainOptions')),context);
 return {context,elements,tables,relations,quality};
}
test('quality UI deduplicates by relationship identity, exposes names and searches either endpoint without UUIDs',()=>{
 const {context:c,elements:e,quality:q}=setup();c.renderDictionaryQuality(q);
 const html=e.get('dictionary-quality-results').innerHTML;
 assert.equal(html.split('<article').length-1,1);
 for(const text of ['Orders','Customers','CustomerID','Khách hàng mua','Xem quan hệ'])assert.ok(html.includes(text));
 assert.ok(!html.includes('internal-uuid'));
 assert.match(e.get('dictionary-quality-summary').textContent,/1 quan hệ/);
 e.get('dictionary-quality-search').value='khach hang';c.filterDictionaryQuality();assert.match(e.get('dictionary-quality-results').innerHTML,/Orders/);
 e.get('dictionary-quality-table').value='target';c.filterDictionaryQuality();assert.match(e.get('dictionary-quality-results').innerHTML,/Orders/);
 e.get('dictionary-quality-kind').value='error';c.filterDictionaryQuality();assert.match(e.get('dictionary-quality-count').textContent,/0 mục/);
});
test('quality UI paginates, clamps pages after filtering, and escapes catalog text',()=>{
 const {context:c,elements:e,quality:q,tables,relations}=setup();
 tables[0].tableName='<img src=x onerror=alert(1)>';
 q.tables[0].issues=[];q.tables[1].issues=[];
 for(let i=0;i<8;i++) {relations.push({...relations[0],id:'r'+i});q.tables[0].issues.push({field:'relationships.r'+i,code:'RELATIONSHIP_UNVERIFIED',severity:'warning'});}
 c.renderDictionaryQuality(q);assert.equal(e.get('dictionary-quality-results').innerHTML.split('<article').length-1,6);
 assert.ok(!e.get('dictionary-quality-results').innerHTML.includes('<img'));
 c.pageDictionaryQuality(1);assert.equal(e.get('dictionary-quality-results').innerHTML.split('<article').length-1,2);
 c.pageDictionaryQuality(1);assert.equal(e.get('dictionary-quality-page').textContent,'2 / 2');
 e.get('dictionary-quality-search').value='no match';c.filterDictionaryQuality();assert.equal(e.get('dictionary-quality-page').textContent,'1 / 1');
});
test('open action selects exact source and expands the hidden relationship section before editing',()=>{
 const {context:c,quality:q}=setup(),calls=[];
 const content={hidden:true,parentElement:{querySelector:()=>({})}};
 const editor={closest:()=>content,scrollIntoView:()=>calls.push('scroll'),querySelector:()=>({focus:()=>calls.push('focus')})};
 c.openDictionaryDrawer=id=>calls.push(['table',decodeURIComponent(id)]);
 c.getFieldRelationshipEditor=()=>editor;
 c.toggleFieldRelationshipEditor=column=>{calls.push(['expand',column]);content.hidden=false;};
 c.editFieldRelationship=(id,column)=>calls.push(['edit',id,column]);
 c.renderDictionaryQuality(q);c.openDictionaryQualityItem(0);
 assert.deepEqual(calls.slice(0,3),[['table','source'],['expand','CustomerID'],['edit','internal-uuid','CustomerID']]);
});

test('quality UI ignores inactive table, key and display columns in either direction',()=>{
 const {context:c,tables,relations,quality:q,elements:e}=setup();
 for(const hide of [()=>{tables[0].isActive=false;},()=>{tables[1].isActive=false;},()=>{tables[0].columns[0].isVisible=false;},()=>{tables[1].columns[0].isVisible=false;}]) {
  for(const table of tables){table.isActive=true;for(const col of table.columns)col.isVisible=true;}
  hide();c.renderDictionaryQuality(q);assert.match(e.get('dictionary-quality-summary').textContent,/0 quan hệ/);
 }
});

test('save payload drops hidden display references before sending to the server',()=>{
 const source=fs.readFileSync('src/frontend/js/modules/dictionary.js','utf8'),context={};
 vm.createContext(context);
 vm.runInContext(source.slice(source.indexOf('function reconcileDictionaryPresentation'),source.indexOf('async function saveSelectedTableDescription')),context);
 const model={identityFields:['ContractLandID'],summaryFields:['ContractLandID','CompanyID','CreateUser'],monetaryFields:[],segments:[]};
 const removed=context.reconcileDictionaryPresentation(model,[{columnName:'CompanyID',isVisible:false},{columnName:'CreateUser',isVisible:false}]);
 assert.deepEqual([...model.summaryFields],['ContractLandID']);
 assert.deepEqual([...removed],['CompanyID','CreateUser']);
 assert.deepEqual(model.identityFields,['ContractLandID']);
});
