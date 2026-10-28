'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {packExecution,compactAgentToolResult}=require('../src/backend/agent/harness/agent_context');
test('schema packing preserves business mappings, labels, joins, scope and every exposed column',()=>{
 const columns=Array.from({length:35},(_,i)=>({name:'Field'+i,description:'C\u1ed9t Field'+i+' trong b\u1ea3ng SQL Server Records'}));
 columns[34].description='Operational maintenance maps to category = 21';columns[34].label='Business category';
 const original={success:true,result:{tables:[{tableName:'Records',columns}],schemaScope:{filters:[{column:'Field34',value:21}]},mappedRelationships:[{businessRole:'Owner',columnPairs:[{sourceColumn:'ID',targetColumn:'ID'}]}]}};
 const result=JSON.parse(compactAgentToolResult('search_schema',original,200));
 assert.equal(result.result.tables[0].columns.length,35);
 assert.equal(result.result.tables[0].columns[0].description,undefined);
 assert.equal(result.result.tables[0].columns[34].description,columns[34].description);
 assert.deepEqual(result.result.schemaScope,original.result.schemaScope);
 assert.deepEqual(result.result.mappedRelationships,original.result.mappedRelationships);
 assert.ok(original.result.tables[0].columns[0].description);
});
test('row packing preserves values, metadata, NULL and missing-field distinction',()=>{
 const original={success:true,result:{rows:Array.from({length:20},(_,i)=>i%2?{Code:'B',Amount:1}:{Code:'A',Amount:0,Note:null}),columns:[{name:'Code',type:'text'},{name:'Amount',unit:'VND'},{name:'Note'}],hasMore:false}};
 const r=packExecution('execute_sql_query',original).result;
 assert.deepEqual(r.columns,['Code','Amount','Note']);assert.deepEqual(r.rows.slice(0,2),[['A',0,null],['B',1,null]]);
 assert.deepEqual(r.missingValueCells[0],[1,2]);assert.equal(r.columnMetadata[1].unit,'VND');assert.equal(r.previewOnly,false);
 assert.deepEqual(original.result.rows[0],{Code:'A',Amount:0,Note:null});
});
test('wide rows are not cut to twenty columns and previews cannot masquerade as complete data',()=>{
 const row=Object.fromEntries(Array.from({length:35},(_,i)=>['Field'+i,i]));
 const result=JSON.parse(compactAgentToolResult('execute_sql_query',{success:true,result:{rows:Array.from({length:25},()=>row),rowCount:25}},100000)).result;
 assert.equal(result.columns.length,35);assert.equal(result.rows[0].length,35);assert.equal(result.rows.length,20);
 assert.equal(result.previewOnly,true);assert.equal(result.returnedRowCount,25);assert.match(result.previewInstruction,/incomplete/);
});
test('packing reduces repeated row keys without dropping business data',()=>{
 const input={success:true,result:{rows:Array.from({length:20},(_,i)=>({LongBusinessIdentifier:i,LongAmountField:100+i,LongCategoryField:'A'}))}};
 const packed=packExecution('execute_sql_query',input);assert.ok(JSON.stringify(packed).length<JSON.stringify(input).length);
 assert.deepEqual(packed.result.rows[19],[19,119,'A']);
});

test('small results keep object format when row encoding would add overhead',()=>{
 const x={success:true,result:{rows:[{Total:123}],rowCount:1}};
 assert.deepEqual(packExecution('execute_sql_query',x),x);
});

test('source row count and partial envelope keep small previews explicitly incomplete',()=>{
 for(const x of [
  {success:true,result:{rows:[{Total:123}],rowCount:10}},
  {success:true,result:{rows:[{Total:123}]},envelope:{completeness:{status:'partial'}}}
 ]) {
  const r=packExecution('execute_sql_query',x).result;
  assert.equal(r.previewOnly,true);assert.equal(r.returnedRowCount,1);
  assert.match(r.previewInstruction,/incomplete/);
 }
});
