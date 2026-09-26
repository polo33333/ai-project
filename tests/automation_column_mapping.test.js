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
