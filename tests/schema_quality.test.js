'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const quality = require('../src/backend/services/schema_quality');
const model = require('../src/backend/services/semantic_model');
const required = require('../src/backend/services/required_filters');
const query = require('../src/backend/services/semantic_query');
const table = () => ({ tableId:'s::db::dbo::records', dbSourceId:'s', dbName:'db', schemaName:'dbo', tableName:'Records', isActive:true,
 columns:[{columnName:'ID',dataType:'int'},{columnName:'Amount',dataType:'decimal(18,2)'},{columnName:'Name',dataType:'nvarchar(50)'},{columnName:'Day',dataType:'datetime2(7)'},{columnName:'Deleted',dataType:'bit'}],
 semanticModel:{version:1,entity:'Record',grain:'One record',identityFields:['ID'],summaryFields:['ID','Name'],segments:[]}});

test('both metadata save paths reject invalid defaults without persisting partial changes', async t => {
 const d = require('../src/backend/services/dictionary_service');
 const original = d.tablesStore, relations = d.tableRelationships;
 t.after(()=>{d.tablesStore=original;d.tableRelationships=relations;});
 d.tablesStore=[table()];d.tableRelationships=[];
 let writes=0;t.mock.method(d,'persist',()=>writes++);t.mock.method(d,'syncToQdrant',async()=>({success:true}));
 for (const updates of [{defaultMetric:'Name',defaultAggregation:'SUM'},{defaultTimeColumn:'Name'}]) {
  await assert.rejects(d.updateTableMetadata('Records',{description:'must roll back',...updates}));
  assert.equal(d.tablesStore[0].tableDescription,undefined);
  await assert.rejects(d.saveTableConfiguration({tableId:table().tableId,table:updates}));
 }
 assert.equal(writes,0);
 await d.saveTableConfiguration({tableId:table().tableId,table:{defaultMetric:'Amount',defaultTimeColumn:'Day'}});
 assert.equal(writes,1);
 await assert.rejects(d.saveTableConfiguration({tableId:table().tableId,columns:[{columnName:'Amount',isVisible:false}]}),{code:'SCHEMA_COLUMN_UNAVAILABLE'});
 assert.notEqual(d.tablesStore[0].columns.find(c=>c.columnName==='Amount').isVisible,false);
});

test('semantic measures reject ambiguity, invalid types and COUNT zero substitution',()=>{
 const t=table(), m=t.semanticModel;
 m.measures=[{column:'Amount',aggregation:'SUM',unit:'VND',nullRule:'exclude'}];
 assert.doesNotThrow(()=>model.validateModel(m,t));
 m.measures.push({...m.measures[0]});assert.throws(()=>model.validateModel(m,t),{code:'SEMANTIC_MEASURE_DUPLICATE'});
 m.measures=[{column:'Name',aggregation:'SUM',unit:'VND',nullRule:'exclude'}];assert.throws(()=>model.validateModel(m,t),{code:'SEMANTIC_MEASURE_NOT_NUMERIC'});
 m.measures=[{column:'ID',aggregation:'COUNT',unit:'rows',nullRule:'zero'}];assert.throws(()=>model.validateModel(m,t),{code:'SEMANTIC_COUNT_NULL_RULE'});
});

test('required filters survive user OR conditions and cannot be bypassed by raw SQL',()=>{
 const t=table();t.requiredFilters=[{column:'Deleted',operator:'eq',value:false}];
 const compiled=query.compile({table:'Records',operation:'list'},[t]);
 assert.throws(()=>query.compile({table:'Records',operation:'list',filters:[{column:'Deleted',operator:'eq',value:true}]},[t]),{code:'SEMANTIC_FILTER_CONFLICT'});
 assert.doesNotThrow(()=>required.enforce(compiled.sql,[t]));
 assert.doesNotThrow(()=>required.enforce('SELECT r.ID FROM dbo.Records r WHERE r.Deleted = 0 AND (r.ID=1 OR r.ID=2)',[t]));
 for(const sql of ['SELECT ID FROM Records','SELECT ID FROM Records WHERE Deleted=0 OR ID=1','SELECT ID FROM Records WHERE Deleted=1',
  'SELECT ID FROM Records WHERE NOT (Deleted=0)','SELECT ID FROM Records WHERE Deleted=0 UNION SELECT ID FROM Records',
  'WITH x AS (SELECT ID FROM Records) SELECT * FROM x','SELECT r.ID FROM Records r JOIN Records s ON r.ID=s.ID',
  'SELECT ID FROM Records WHERE Deleted=0 AND ID IN (SELECT ID FROM Records)']) assert.throws(()=>required.enforce(sql,[t]),sql);
});

test('common connector boundary rejects bypass before opening a SQL connection', async t=>{
 const connector=require('../src/backend/services/sql_connector');
 const dictionary=require('../src/backend/services/dictionary_service');
 const old=connector.dbSources;
 t.after(()=>{connector.dbSources=old;});
 connector.dbSources=[{id:'quality-test',mode:'live'}];
 const record=table();record.dbSourceId='quality-test';record.requiredFilters=[{column:'Deleted',operator:'eq',value:false}];
 t.mock.method(dictionary,'getGroupedTables',()=>[record]);
 t.mock.method(require('../src/backend/governance/context'),'read',()=>{});
 await assert.rejects(connector.executeAdmittedSql('SELECT ID FROM Records','quality-test'),{code:'REQUIRED_FILTER_MISSING'});
});

test('required filters use typed values and null predicates without treating segments as mandatory',()=>{
 const t=table();t.requiredFilters=[{column:'Name',operator:'is_not_null'}];
 const sql=query.compile({table:'Records',operation:'list'},[t]).sql;
 assert.doesNotThrow(()=>required.enforce(sql,[t]));
 assert.throws(()=>required.validate([{column:'Amount',operator:'eq',value:'1'}],t),{code:'REQUIRED_FILTER_TYPE'});
 assert.throws(()=>required.validate([{column:'ID',operator:'is_null',value:1}],t),{code:'REQUIRED_FILTER_VALUE_INVALID'});
 t.columns.find(c=>c.columnName==='Name').isVisible=false;
 assert.throws(()=>required.validate(t.requiredFilters,t),{code:'REQUIRED_FILTER_COLUMN_UNAVAILABLE'});
});

test('malformed persisted policies fail closed even before query resolution',()=>{
 for(const policy of [null,{},'invalid',[{column:'Missing',operator:'is_null'}]]) {
  const t=table();t.requiredFilters=policy;
  assert.throws(()=>required.enforce('SELECT ID FROM Records',[t]));
  assert.throws(()=>query.compile({table:'Records',operation:'list'},[t]));
 }
});

test('audit reports same-source alias ambiguity and invalid metadata without changing inputs',()=>{
 const a=table(), b={...table(),tableId:'other',tableName:'Other'};
 const before=JSON.stringify([a,b]);const report=quality.audit([a,b]);
 assert.equal(JSON.stringify([a,b]),before);
 assert.equal(report.tables.filter(t=>t.issues.some(i=>i.code==='SEMANTIC_ALIAS_AMBIGUOUS')).length,2);
 b.dbSourceId='other';assert.equal(quality.audit([a,b]).tables.some(t=>t.issues.some(i=>i.code==='SEMANTIC_ALIAS_AMBIGUOUS')),false);
});

test('verified relationships cannot authorize missing columns, empty keys or inactive tables', t=>{
 const dictionary=require('../src/backend/services/dictionary_service');
 const a=table(),b={...table(),tableId:'b',tableName:'Other'};
 t.mock.method(dictionary,'getGroupedTables',()=>[a,b]);
 const relation={id:'r',sourceTableId:a.tableId,targetTableId:b.tableId,status:'verified',columnPairs:[{sourceColumn:'ID',targetColumn:'ID'}]};
 t.mock.method(dictionary,'getTableRelationships',()=>[relation]);
 const service=require('../src/backend/services/relationship_service');
 assert.equal(service.verifiedRelationships().length,1);
 relation.columnPairs[0].targetColumn='Missing';assert.equal(service.verifiedRelationships().length,0);
 relation.columnPairs=[];assert.equal(service.verifiedRelationships().length,0);
 relation.columnPairs=[{sourceColumn:'ID',targetColumn:'ID'}];b.isActive=false;assert.equal(service.verifiedRelationships().length,0);
});

test('audit ignores disabled relationship endpoints but retains missing-column errors',()=>{
 const a=table(),b={...table(),tableId:'b',tableName:'Other'};
 const relation={id:'r',sourceTableId:a.tableId,targetTableId:b.tableId,status:'suggested',columnPairs:[{sourceColumn:'ID',targetColumn:'ID'}]};
 const count=()=>quality.audit([a,b],[relation]).tables.flatMap(t=>t.issues).filter(i=>i.code.startsWith('RELATIONSHIP_')).length;
 assert.equal(count(),2);
 a.columns.find(c=>c.columnName==='ID').isVisible=false;assert.equal(count(),0);
 a.columns.find(c=>c.columnName==='ID').isVisible=true;b.isActive=false;assert.equal(count(),0);
 b.isActive=true;relation.status='verified';relation.columnPairs[0].targetColumn='Missing';assert.equal(count(),2);
});

test('hiding a summary column saves successfully while preserving identity, filters and relationship definitions',async t=>{
 const d=require('../src/backend/services/dictionary_service'),old=d.tablesStore,oldRelations=d.tableRelationships;
 t.after(()=>{d.tablesStore=old;d.tableRelationships=oldRelations;});
 const record=table();record.semanticModel.summaryFields.push('Amount');record.semanticModel.monetaryFields=['Amount'];
 d.tablesStore=[record];d.tableRelationships=[];
 t.mock.method(d,'persist',()=>{});t.mock.method(d,'syncToQdrant',async()=>({success:true}));
 const result=await d.saveTableConfiguration({tableId:record.tableId,table:{semanticModel:structuredClone(record.semanticModel)},columns:[{columnName:'Name',isVisible:false},{columnName:'Amount',isVisible:false}]});
 assert.deepEqual(result.table.semanticModel.summaryFields,['ID']);
 assert.deepEqual(result.table.semanticModel.identityFields,['ID']);
 assert.deepEqual(result.table.semanticModel.monetaryFields,[]);
 assert.equal(result.table.columns.find(c=>c.columnName==='Name').isVisible,false);
 assert.equal(result.configurationAdjustments.length,2);
 await assert.rejects(d.saveTableConfiguration({tableId:record.tableId,columns:[{columnName:'ID',isVisible:false}]}),error=>error.code==='SEMANTIC_COLUMN_UNAVAILABLE'&&error.message.includes('Cột định danh: ID'));
 assert.notEqual(d.tablesStore[0].columns.find(c=>c.columnName==='ID').isVisible,false);
});
