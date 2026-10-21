'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stages = require('../src/backend/agent_core/harness/staged_tools');
const governance = require('../src/backend/governance/context');

test('scoped aggregates finish with exact projected attributes, never WHERE-only or unresolved fields', () => {
 const {canFinalizeVerifiedRead}=require('../src/backend/agent_core/harness/completion_policy');
 const plan={outputs:{data:true},conversationState:{operation:'aggregate',requestedAttributes:['Amount']},schemaScope:{filters:[]}};
 // Validated empty scope permits whole-source aggregation; absent scope does not.
 const call={success:true,result:{rows:[{Total:12}],sql:'SELECT SUM(Amount) AS Total FROM Records WHERE Category = 21'}};
 assert.equal(canFinalizeVerifiedRead({...plan,schemaScope:undefined},call),false);
 assert.equal(canFinalizeVerifiedRead(plan,call),true);
 plan.schemaScope.filters=[{table:'Records',column:'Category',value:21}];
 assert.equal(canFinalizeVerifiedRead(plan,call),true);
 plan.conversationState.requestedAttributes=['Category'];
 assert.equal(canFinalizeVerifiedRead(plan,call),false);
 plan.conversationState.requestedAttributes=['Unknown'];
 assert.equal(canFinalizeVerifiedRead(plan,call),false);
});

test('verified read finishes only with complete evidence and no pending additional outputs', () => {
  const { canFinalizeVerifiedRead } = require('../src/backend/agent_core/harness/completion_policy');
  const { createRequestContract } = require('../src/backend/agent_core/harness/request_contract');
  const plan = { table: 'records', outputs: { data: true }, conversationState: { operation: 'list' } };
  plan.requestContract = createRequestContract(plan, { tables: [{ tableName: 'records', columns: [{ name: 'code', description: 'Identity' }, { name: 'value', description: 'Value' }] }] });
  const call = { success: true, result: { rows: [{ code: 'A', value: null }] } };
  assert.equal(canFinalizeVerifiedRead(plan, call), true);
  assert.equal(canFinalizeVerifiedRead(plan, { ...call, result: { rows: [{ code: 'A' }] } }), false);
  assert.equal(canFinalizeVerifiedRead(plan, { ...call, result: { ...call.result, hasMore: true } }), false);
  assert.equal(canFinalizeVerifiedRead({ ...plan, outputs: { data: true, chart: true } }, call), false);
  assert.equal(canFinalizeVerifiedRead({ ...plan, outputs: { data: true, export: true } }, call), false);
  assert.equal(canFinalizeVerifiedRead(plan, call, { knowledgeGrounding: { required: true } }), false);
  assert.equal(canFinalizeVerifiedRead({ outputs: { data: true }, conversationState: { operation: 'aggregate' } }, call), false);
});

test('superseded schema compaction preserves native tool-call pairing and latest metadata', () => {
  const { compactSupersededSchemas } = require('../src/backend/agent_core/harness/local_result_compactor');
  const messages = [{ role: 'assistant', tool_calls: [{ id: 'first' }] },
    { role: 'tool', name: 'search_schema', tool_call_id: 'first', content: JSON.stringify({ success: true, result: { selectedTables: ['records'], tables: ['old'] } }) },
    { role: 'assistant', tool_calls: [{ id: 'second' }] },
    { role: 'tool', name: 'search_schema', tool_call_id: 'second', content: JSON.stringify({ success: true, result: { selectedTables: ['records'], tables: ['current'], mappings: ['verified'] } }) }];
  const compacted = compactSupersededSchemas(messages);
  assert.equal(compacted.length, messages.length);
  assert.equal(compacted[1].tool_call_id, 'first');
  assert.equal(JSON.parse(compacted[1].content).superseded, true);
  assert.equal(compacted[3].content, messages[3].content);
  assert.ok(messages[1].content.includes('old'));
  const otherScope = messages.map(message => ({ ...message }));
  otherScope[3].content = JSON.stringify({ success: true, result: { selectedTables: ['other'] } });
  assert.equal(compactSupersededSchemas(otherScope)[1].content, messages[1].content);
});

test('tool stages omit SQL and output schemas until their prerequisites complete', () => {
  const definitions = require('../src/backend/agent_core').defaultToolManager.getToolDefinitions({ permissions: ['admin'] });
  const names = defs => defs.map(tool => tool.function.name);
  const initial = stages.select(definitions);
  assert.ok(!names(initial).includes('execute_sql_query')); assert.ok(!names(initial).includes('export_data'));
  assert.ok(!names(initial).includes('run_workflow'));
  const data = stages.select(definitions, { completed: ['list_workflows', 'search_schema'] });
  assert.ok(names(data).includes('execute_sql_query')); assert.ok(names(data).includes('run_workflow'));
  const output = stages.select(definitions, { completed: ['execute_sql_query'] });
  assert.ok(names(output).includes('export_data'));
  assert.ok(JSON.stringify(initial).length < JSON.stringify(definitions).length * 0.65);
});

test('projection guard rejects wildcard row retrieval while allowing COUNT and multiplication', () => {
  assert.equal(stages.hasWildcardProjection('SELECT TOP 1 * FROM M_Employee'), true);
  assert.equal(stages.hasWildcardProjection('SELECT e.* FROM M_Employee e'), true);
  assert.equal(stages.hasWildcardProjection('SELECT COUNT(*) FROM M_Employee'), false);
  assert.equal(stages.hasWildcardProjection('SELECT Qty * Price AS Amount FROM Sales'), false);
  assert.equal(stages.hasWildcardProjection('SELECT EmployeeCode, PRAddress FROM M_Employee'), false);
});

test('workflow cache is conversation-scoped and invalidates on catalog version or effective permissions', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:cache-owner', role: 'user' });
  const automation = require('../src/backend/automation'), workflows = require('../src/backend/governance/workflow_tools');
  const context = { session: { id: 'cache-test', accountId: 'cache-owner' }, permissions: ['sql:read'] };
  let version = 1;
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [{ id: 'pkg/detail', name: 'Detail', packageVersion: version, bindings: {}, inputs: {} }]);
  t.mock.method(automation.runtime, 'pending', async () => null);
  assert.equal(await workflows.cachedCatalog(context), null);
  await workflows.execute('list_workflows', {}, context);
  assert.equal((await workflows.cachedCatalog(context))[0].templateVersion, 1);
  assert.equal(await workflows.cachedCatalog({ ...context, session: { ...context.session, id: 'other' } }), null);
  assert.equal(await workflows.cachedCatalog({ ...context, permissions: [] }), null);
  version = 2;
  assert.equal(await workflows.cachedCatalog(context), null);
}));

test('basic lists require identity fields without forcing a full profile or display joins', () => {
  const { createRequestContract } = require('../src/backend/agent_core/harness/request_contract');
  const plan = { table: 'Customers', identityColumns: ['ID','Code','Name'], displayIdentityColumns: ['Code','Name'],
    conversationState: { operation: 'list', requestedAttributes: [] } };
  const schema = { tables: [{ tableName: 'Customers', columns: [
    { name: 'ID', description: 'Internal ID' }, { name: 'Code', description: 'Code' },
    { name: 'Name', description: 'Name' }, { name: 'Address', description: 'Address' }
  ] }] };
  const contract = createRequestContract(plan, schema);
  assert.equal(contract.completeness.mode, 'identity_fields');
  assert.deepEqual(contract.attributes.map(x=>x.name), ['ID','Code','Name']);
  assert.ok(createRequestContract({ ...plan, conversationState: { operation: 'detail', requestedAttributes: [] } }, schema).attributes.some(x=>x.name==='Address'));
  assert.ok(createRequestContract({ ...plan, conversationState: { operation: 'list', requestedAttributes: ['Address'] } }, schema).attributes.some(x=>x.name==='Address'));
});

test('scoped aggregates expose execution instead of repeated retrieval', () => {
  const definitions=['search_schema','search_knowledge_base','calculate_stats','execute_sql_query','list_workflows','get_current_datetime'].map(name=>({type:'function',function:{name}}));
  const names=stages.select(definitions,{completed:['search_schema','list_workflows'],scopedAggregate:true}).map(x=>x.function.name);
  assert.ok(names.includes('execute_sql_query'));assert.ok(names.includes('get_current_datetime'));
  assert.ok(!names.includes('search_schema'));assert.ok(!names.includes('search_knowledge_base'));
  assert.ok(!names.includes('list_workflows'));
  const discovery=stages.select(definitions,{completed:['search_schema'],scopedAggregate:true}).map(x=>x.function.name);
  assert.ok(discovery.includes('list_workflows'));
});

test('entity identity does not force unrelated contact or tax fields into basic lists',()=>{
 const {createRequestPlan}=require('../src/backend/training_core');
 const plan=createRequestPlan({question:'ds kh',selectedTables:['M_Customer'],dictionaryTables:[{tableName:'M_Customer',columns:[
  {columnName:'CustomerID',dataType:'int',isPrimaryKey:true},{columnName:'CustomerCode',dataType:'varchar'},
  {columnName:'CustomerName',dataType:'nvarchar'},{columnName:'TaxCode',dataType:'varchar'},{columnName:'ContactName',dataType:'nvarchar'}]}]});
 assert.deepEqual(plan.identityColumns,['CustomerID','CustomerCode','CustomerName']);
});
