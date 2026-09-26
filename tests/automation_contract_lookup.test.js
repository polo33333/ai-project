'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('contract lookup uses parameterized SQL and verified mapping with complete fixtures',async()=>{
 const bundle=require('../docs/templates/contract_lookup.json');
 const {validatePackage,validateInputs}=require('../src/backend/automation/contract'); validatePackage(bundle);
 const template=bundle.templates[0],binding=template.bindings.contract;
 assert.equal(validateInputs(template,{}).valid,false);
 assert.equal(validateInputs(template,{query:"HD'001"}).valid,true);
 assert.deepEqual(binding.parameters.query,{slot:'query',type:'string'});
 assert.match(binding.sql,/LEFT JOIN/); assert.match(binding.sql,/@query/);
 assert.equal(binding.resultMapping.length,15);
 assert.deepEqual(binding.resultMapping.filter(m=>m.relationId).map(m=>m.label).sort(),['Khách hàng','Nhân viên','Trạng thái']);
 const {PluginRegistry}=require('../src/backend/automation/registry'); assert.equal((await new PluginRegistry(null).testBundle(bundle)).passed,true);
});
