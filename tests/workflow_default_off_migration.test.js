'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {plan}=require('../scripts/migrate_workflow_default_off');
test('switching to default-off keeps every published package on for groups that use workflows',()=>{
 const records=[{id:'_settings'},{id:'_mcp_host'},{id:'employee_lookup',published:{}},{id:'contract_lookup',published:{}},{id:'draft_only',draft:{}}];
 const groups=[
  {id:'user',name:'Người dùng',permissions:['chat.use','workflows.use'],workflows:[],revision:4},
  {id:'nhan_su',name:'Nhân sự',permissions:['workflows.use'],workflows:['employee_lookup','draft_only'],workflowsOff:['contract_lookup'],revision:1},
  {id:'co_ban',name:'Cơ bản',permissions:['chat.use'],workflows:[],revision:1}];
 const {groups:next,report}=plan(groups,records);
 assert.deepEqual(report.published,['employee_lookup','contract_lookup']);
 assert.deepEqual(next[0].workflows,['employee_lookup','contract_lookup']);assert.equal(next[0].revision,5);
 // A package the group had already turned off stays off, and the old off list is dropped;
 // an unpublished package the group was given stays on for it.
 assert.deepEqual(next[1].workflows,['employee_lookup','draft_only']);assert.equal('workflowsOff' in next[1],false);
 // Groups without the workflow permission are left as they were.
 assert.equal(next[2],groups[2]);
 assert.deepEqual(report.groups.map(item=>item.id),['user','nhan_su']);
});
