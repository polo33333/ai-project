'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('original user role expands verified paths even when tool search omits the grouping dimension',async t=>{
 const old=process.env.SQL_JOIN_PLANNER_ENABLED;process.env.SQL_JOIN_PLANNER_ENABLED='true';
 t.after(()=>{if(old===undefined)delete process.env.SQL_JOIN_PLANNER_ENABLED;else process.env.SQL_JOIN_PLANNER_ENABLED=old;});
 const identity=require('../src/backend/services/schema_identity').withIdentity;
 const tables=[identity({dbSourceId:'fixture',dbName:'FixtureDb',tableName:'Records',isActive:true,columns:[{columnName:'ID',dataType:'INT',isPrimaryKey:true},{columnName:'PartyID',dataType:'INT'}]}),
 identity({dbSourceId:'fixture',dbName:'FixtureDb',tableName:'Parties',isActive:true,columns:[{columnName:'PartyID',dataType:'INT',isPrimaryKey:true},{columnName:'PartyName',dataType:'NVARCHAR'}]})];
 const relation={id:'record-party',sourceTableId:tables[0].tableId,targetTableId:tables[1].tableId,sourceTable:'Records',targetTable:'Parties',isActive:true,status:'verified',cardinality:'many-to-one',businessRole:'Party',displayColumn:'PartyName',columnPairs:[{sourceColumn:'PartyID',targetColumn:'PartyID'}]};
 const dictionary=require('../src/backend/services/dictionary_service');
 t.mock.method(dictionary,'getGroupedTables',()=>tables);t.mock.method(dictionary,'getTableRelationships',()=>[relation]);t.mock.method(dictionary,'getGlossary',()=>[]);
 t.mock.method(require('../src/backend/assistant/domain_alias_service'),'getDomainAliases',()=>({}));
 t.mock.method(require('../src/backend/services/embedding_policy'),'enabled',()=>false);
 const service=require('../src/backend/assistant/schema_context_service');
 const without=await service.buildSchemaContext('Records',{dbSourceId:'fixture',forceRetrieval:true,operation:'aggregate'});
 assert.deepEqual(without.selectedTables,['Records']);
 const expanded=await service.buildSchemaContext('Records',{dbSourceId:'fixture',forceRetrieval:true,operation:'aggregate',question:'Totals by Party'});
 assert.ok(expanded.selectedTables.includes('Parties'));assert.equal(expanded.joinPlan.outcome,'ready');
 const refined=service.refineSchemaContext('Records',['Records'],{dbSourceId:'fixture',operation:'list',attributes:[],question:'Totals by Party'});
 assert.ok(refined.selectedTables.includes('Parties'));
 relation.status='suggested';
 const suggested=await service.buildSchemaContext('Records',{dbSourceId:'fixture',forceRetrieval:true,operation:'aggregate',question:'Totals by Party'});
 assert.deepEqual(suggested.selectedTables,['Records']);
});
