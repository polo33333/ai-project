'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildSelect}=require('../src/backend/automation/column_mapping');
test('SQL mapping uses active verified relationships and refuses ambiguous joins',()=>{
 const source={tableId:'employee',dbSourceId:'db',tableName:'Employee',columns:[{columnName:'Code',displayName:'Mã'},{columnName:'DepartmentID'},{columnName:'Secret',isVisible:false}]};
 const target={tableId:'department',dbSourceId:'db',tableName:'Department',isActive:true,columns:[{columnName:'ID'},{columnName:'Name'}]};
 const relation={id:'rel',sourceTableId:'employee',targetTableId:'department',status:'verified',cardinality:'many-to-one',displayColumn:'Name',businessRole:'Phòng ban',columnPairs:[{sourceColumn:'DepartmentID',targetColumn:'ID'}]};
 const dictionary={tablesStore:[source,target],tableRelationships:[relation]};
 let mapping=buildSelect(source,dictionary);
 assert.match(mapping.select,/LEFT JOIN \[dbo\]\.\[Department\]/); assert.match(mapping.select,/r1\.\[Name\] AS \[DepartmentID\]/); assert.doesNotMatch(mapping.select,/Secret/);
 assert.equal(mapping.resultMapping[1].label,'Phòng ban');
 relation.status='suggested'; assert.doesNotMatch(buildSelect(source,dictionary).select,/JOIN/);
 relation.status='verified'; target.columns[1].isVisible=false; assert.doesNotMatch(buildSelect(source,dictionary).select,/JOIN/);
 target.columns[1].isVisible=true; dictionary.tableRelationships.push({...relation,id:'another'}); assert.doesNotMatch(buildSelect(source,dictionary).select,/JOIN/);
});

test('result tables omit configured columns absent from SQL rows while keeping null values', () => {
 const {AutomationRuntime}=require('../src/backend/automation/runtime');
 const run={id:'result',templateId:'lookup',status:'SUCCEEDED',input:{},missing:[],invalid:[],attempts:{},artifacts:[],definition:{name:'Lookup',inputs:{},workflow:{steps:[]},output:{mapping:{},presentation:{columns:{records:['RemovedID','RemovedType','Number','Optional']},labels:{'records.Number':'Number'}}}},result:{records:[{Number:'A001',Optional:null}]}};
 const view=AutomationRuntime.prototype.view(run);
 assert.deepEqual(view.presentation.columns.records,['Number','Optional']);
 assert.deepEqual(view.result.records,[{Number:'A001',Optional:null}]);
 assert.deepEqual(run.definition.output.presentation.columns.records,['RemovedID','RemovedType','Number','Optional']);
});
