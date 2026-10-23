const test=require('node:test'),assert=require('node:assert/strict');
const {bind}=require('../src/backend/agent_core/harness/request_filters');
const {matchesScope}=require('../src/backend/agent_core/harness/schema_scope');
const tables=[{tableName:'Documents',columns:[{name:'CycleID',type:'INT'}]},{tableName:'Clients',columns:[{name:'Code',type:'VARCHAR'},{name:'Hidden',isVisible:false}]}];
test('every explicit equality qualifier binds to authorized metadata and original question evidence',()=>{
  const question='Details for AC012 cycle 20';
  const filters=bind([{table:'Documents',column:'CycleID',value:20,evidence:'cycle 20'},{table:'Clients',column:'Code',value:'AC012',evidence:'AC012'}],tables,question);
  const sql="SELECT d.CycleID FROM Documents d JOIN Clients c ON d.ClientID=c.ID WHERE c.Code=N'AC012' AND d.CycleID=20";
  assert.equal(matchesScope(sql,filters),true);
  assert.equal(matchesScope(sql.replace(' AND d.CycleID=20',''),filters),false);
  assert.equal(matchesScope(sql.replace('d.CycleID=20','(d.CycleID=20 OR d.CycleID=19)'),filters),false);
  assert.equal(matchesScope(sql.replace('d.CycleID=20','c.CycleID=20'),filters),false);
  assert.equal(matchesScope(sql.replace('d.CycleID=20','d.CycleID=19'),filters),false);
  assert.throws(()=>bind([{table:'Clients',column:'Hidden',value:'AC012',evidence:'AC012'}],tables,question),/UNGROUNDED/);
  assert.throws(()=>bind([{table:'Clients',column:'Code',value:'other',evidence:'AC012'}],tables,question),/UNGROUNDED/);
});
test('a successful broader SQL result cannot be accepted by final completion',()=>{
  const {assessSqlEvidence}=require('../src/backend/agent_core/harness/completion_policy');
  const plan={table:'Documents',requestFilters:[{table:'Documents',column:'CycleID',value:20}]};
  const result=assessSqlEvidence({toolName:'execute_sql_query',success:true,result:{sql:'SELECT CycleID FROM Documents',rows:[{CycleID:19}]}},plan);
  assert.equal(result.accepted,false);assert.ok(result.failures.includes('REQUEST_FILTER_REQUIRED'));
});
