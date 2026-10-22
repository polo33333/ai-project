'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.GOVERNED_CONTROLLER_MODE;
const governance = require('../src/backend/governance/context');
const core = require('../src/backend/intelligent_core/core');

test('age-ranking execution retains scoped ties and the grounded conclusion through final rendering',async t=>{
 const Harness=require('../src/backend/agent_core/harness/guarded_agent_harness'),manager=require('../src/backend/agent_core').defaultToolManager;
 const ranking={kind:'youngest',subject:'employee',column:'BirthDate',identityColumns:['Name','Code']};
 const dataQuery={table:'People',operation:'list',fields:['Name','Code','BirthDate'],ranking};
 const table={tableName:'People',dbSourceId:'age-fixture',isActive:true,columns:[{columnName:'ID',dataType:'INT',isPrimaryKey:true},{columnName:'Name',dataType:'NVARCHAR'},{columnName:'Code',dataType:'NVARCHAR'},{columnName:'BirthDate',dataType:'DATE'}]};
 t.mock.method(require('../src/backend/services/dictionary_service'),'getGroupedTables',()=>[table]);
 t.mock.method(manager.getTool('list_workflows'),'run',async()=>({workflows:[]}));
 t.mock.method(manager.getTool('search_schema'),'run',async()=>({mode:'data',dbSourceId:'age-fixture',selectedTables:['People'],tables:[{...table,columns:table.columns.map(c=>({name:c.columnName,type:c.dataType}))}]}));
 const execution=t.mock.method(manager.getTool('execute_sql_query'),'run',async args=>({sql:args.sql,rowCount:2,rows:[{ID:1,Name:'A',Code:'A1',BirthDate:'2002-05-24'},{ID:2,Name:'B',Code:'B1',BirthDate:'2002-05-24'}]}));
 const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const responses=[call('list_workflows',{}),call('search_schema',{query:'People'}),call('execute_sql_query',{dataQuery})];
 const result=await new Harness({toolManager:manager,dispatch:async()=>responses.shift()||{content:'done'}}).run({userMessage:'youngest employee',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['list_workflows','search_schema','execute_sql_query'],context:{governedController:true,lockProvider:true,mode:'data',dbSourceId:'age-fixture',permissions:['sql:read'],requestPlan:{table:'People',intent:'list',presentation:'table',schemaColumns:['ID','Name','Code','BirthDate'],outputs:{data:true},schemaScope:{filters:[]},conversationState:{operation:'list',requestedAttributes:[]}}}});
 assert.equal(execution.mock.callCount(),1);
 assert.ok(result.replyText.includes('**A · A1**, **B · B1** đồng hạng trẻ nhất'));
 assert.ok(!result.replyText.includes('Thứ tự truy vấn'));
});

test('the verified join path is carried into the next SQL tool context',async()=>{
 const Base=require('../src/backend/agent_core/tools/base_tool'),Manager=require('../src/backend/agent_core/tools/tool_manager'),Harness=require('../src/backend/agent_core/harness/guarded_agent_harness');
 const manager=new Manager();const register=(name,run)=>{const t=new Base({name,description:name,parameters:{type:'object',properties:{sql:{type:'string'},query:{type:'string'},fromTable:{type:'string'},toTable:{type:'string'}}}});t.run=run;manager.registerTool(t);};
 register('list_workflows',async()=>({workflows:[]}));
 register('search_schema',async()=>({mode:'data',dbSourceId:'fixture',selectedTables:['Orders'],tables:[{tableName:'Orders',columns:[{name:'Amount',dataType:'float'}]}]}));
 register('get_join_path',async()=>({outcome:'ready',verified:true,dbSourceId:'fixture',tableRefs:[{tableId:'o',tableName:'Orders'},{tableId:'c',tableName:'Customers'}],edges:[{relationshipId:'oc'}]}));
 let executed=false;
 register('execute_sql_query',async(args,context)=>{assert.equal(context.joinPlan.edges[0].relationshipId,'oc');assert.deepEqual(context.joinPlan.allowedTableNames,['Orders','Customers']);executed=true;return {sql:args.sql,rows:[{Total:25}]};});
 const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const responses=[call('list_workflows',{}),call('search_schema',{query:'Orders'}),call('get_join_path',{fromTable:'Orders',toTable:'Customers'}),call('execute_sql_query',{sql:'SELECT SUM(Amount) AS Total FROM Orders'}),{content:'25'}];
 const result=await new Harness({toolManager:manager,dispatch:async()=>responses.shift()||{content:'25'}}).run({userMessage:'sum order amount',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,mode:'data',dbSourceId:'fixture',requestPlan:{table:'Orders',intent:'aggregate',schemaColumns:['Amount'],outputs:{data:true},schemaScope:{filters:[]},conversationState:{operation:'aggregate',requestedAttributes:[]}}}});
 assert(executed);assert(result.trace.steps.some(s=>s.type==='VERIFIED_JOIN_PLAN_INSTALLED'));
});

test('reused schema cannot erase a verified three-table JOIN path acquired later',async()=>{
 const Base=require('../src/backend/agent_core/tools/base_tool'),Manager=require('../src/backend/agent_core/tools/tool_manager'),Harness=require('../src/backend/agent_core/harness/guarded_agent_harness');
 const manager=new Manager();
 const register=(name,run)=>{const tool=new Base({name,description:name,parameters:{type:'object',properties:{sql:{type:'string'},query:{type:'string'},fromTable:{type:'string'},toTable:{type:'string'}}}});tool.run=run;manager.registerTool(tool);};
 const refs=[{tableId:'o',tableName:'Orders'},{tableId:'h',tableName:'Headers'},{tableId:'c',tableName:'Customers'}];
 const edges=[{relationshipId:'oh',fromTableId:'o',toTableId:'h',columnPairs:[{sourceColumn:'HeaderID',targetColumn:'ID'}],cardinality:'many-to-one'},
  {relationshipId:'hc',fromTableId:'h',toTableId:'c',columnPairs:[{sourceColumn:'CustomerID',targetColumn:'ID'}],cardinality:'many-to-one'}];
 const initial={outcome:'ready',dbSourceId:'fixture',tableRefs:refs.slice(0,2),edges:edges.slice(0,1)};
 register('list_workflows',async()=>({workflows:[]}));
 let searches=0;
 register('search_schema',async()=>{searches++;return {mode:'data',dbSourceId:'fixture',selectedTables:['Orders'],tables:[{tableName:'Orders',columns:[{name:'Amount'}]}],joinPlan:structuredClone(initial)};});
 register('get_join_path',async()=>({outcome:'ready',verified:true,dbSourceId:'fixture',tableRefs:refs,edges}));
 let checked=false;
 register('execute_sql_query',async(args,context)=>{
  assert.ok(context.joinPlan.tableRefs.some(ref=>ref.tableName==='Customers'),'Customer scope from get_join_path must survive schema reuse');
  assert.equal(require('../src/backend/services/sql_join_validator').validateSqlAgainstJoinPlan(args.sql,context.joinPlan).valid,true);
  checked=true;return {rows:[{Total:25}],sql:args.sql};
 });
 const call=(name,args)=>({tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
 const sql='SELECT SUM(o.Amount) AS Total FROM Orders o JOIN Headers h ON o.HeaderID=h.ID JOIN Customers c ON h.CustomerID=c.ID';
 const responses=[call('list_workflows',{}),call('search_schema',{query:'Orders'}),call('search_schema',{query:'Headers'}),call('get_join_path',{fromTable:'Orders',toTable:'Customers'}),call('search_schema',{query:'Customers'}),call('execute_sql_query',{sql})];
 const result=await new Harness({toolManager:manager,dispatch:async()=>responses.shift()||{content:'25'}}).run({userMessage:'Sum orders for customer',provider:{id:'fixture',supportsToolCalling:true},context:{governedController:true,lockProvider:true,dbSourceId:'fixture',mode:'data',requestPlan:{table:'Orders',intent:'aggregate',schemaColumns:['Amount'],outputs:{data:true},schemaScope:{filters:[]},conversationState:{operation:'aggregate',requestedAttributes:[]}}}});
 assert.equal(searches,2,'Third search is the bounded schema reuse path');
 assert.ok(checked);assert.equal(result.trace.completionStatus,'SUCCESS');
});

test('an exact authorized schema lookup replaces a stale root and narrows aggregate discovery',async t=>governance.run(async()=>{
 governance.setPrincipal({subject:'account:root-recovery',role:'admin'});
 const connector=require('../src/backend/services/sql_connector'),dictionary=require('../src/backend/services/dictionary_service');
 connector.dbSources.push({id:'root-fixture',database:'FixtureDb',governedPolicy:{allowedTables:['Invoices']}});
 t.after(()=>{connector.dbSources=connector.dbSources.filter(s=>s.id!=='root-fixture');});
 t.mock.method(dictionary,'getGroupedTables',()=>['Invoices','Balances','Private'].map(name=>({tableName:name,tableId:name,dbSourceId:'root-fixture',isActive:true,columns:[{columnName:'ID',dataType:'int'}]})));
 const schema=require('../src/backend/intelligent_core/schema_context_service');
 t.mock.method(schema,'buildSchemaContext',async(q,o)=>{assert.equal(o.primaryTable,'Invoices');return {mode:'data',selectedTables:['Invoices','Private'],retrieval:{}};});
 const refined=t.mock.method(schema,'refineSchemaContext',(q,names)=>{assert.deepEqual(names,['Invoices']);return {mode:'data',selectedTables:names};});
 const r=await require('../src/backend/intelligent_core/tool_registry').executeTool('search_schema',{query:'Invoices',request:{operation:'aggregate',attributes:[],presentation:'text'}},{governedController:true,dbSourceId:'root-fixture',permissions:['sql:read'],requestPlan:{table:'Balances',conversationState:{operation:'aggregate'}}});
 assert.equal(r.success,true);assert.equal(refined.mock.callCount(),1);
 assert.equal(r.result.requestedPrimaryTable,'Invoices');assert.deepEqual(r.result.tables.map(t=>t.tableName),['Invoices']);
 assert.deepEqual(r.result.tableDirectory.map(t=>t.tableName),['Invoices']);
}));

test('schema-backed missing field answers stop without SQL or repair loops', async t => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  t.mock.method(manager.getTool('search_schema'), 'run', async () => ({ mode: 'data', selectedTables: ['M_Employee'],
    tables: [{ tableName: 'M_Employee', columns: [{ name: 'EmployeeCode' }, { name: 'EmployeeName' }] }] }));
  let calls = 0;
  const harness = new Harness({ toolManager: manager, dispatch: async () => ++calls === 1 ? { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: '{"query":"employee address"}' } }] }
    : { content: 'Bảng nhân viên chưa có trường địa chỉ, nên chưa thể xác định địa chỉ của NV007.' } });
  const result = await harness.run({ userMessage: 'address of NV007', provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['search_schema'], context: { governedController: true, lockProvider: true, mode: 'data', requestPlan: { table: 'M_Employee', intent: 'record_lookup', outputs: { data: true } } } });
  assert.equal(calls, 2); assert.match(result.replyText, /chưa có trường địa chỉ/);
  assert.equal(result.trace.executionBudget.sqlAttempts, 0); assert.equal(result.trace.executionBudget.repairAttempts, 0);
});

test('entity memory derives canonical keys from configured result aliases', () => {
  const { deriveReferences } = require('../src/backend/memory_core/reference_store');
  const references = deriveReferences({ currentPlan: { table: 'M_Employee', columnDisplayNames: { EmployeeCode: 'Mã nhân viên', EmployeeName: 'Tên nhân viên' } },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ 'Mã nhân viên': 'NV007', 'Tên nhân viên': 'Nguyễn Văn B' }] } }] });
  assert.equal(references.lastEntity.filters.EmployeeCode, 'NV007'); assert.equal(references.lastEntity.table, 'M_Employee');
});

test('general chat invokes no schema or document embedding before answering', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'user' });
  const provider = { id: 'general-model', model: 'fixture', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:9911', supportsToolCalling: true, contextWindow: 64000 };
  const providers = require('../src/backend/services/ai_provider_manager');
  t.mock.method(providers, 'getProviderForExecution', () => provider);
  t.mock.method(providers, 'getActiveProvider', () => provider);
  t.mock.method(require('../src/backend/knowledge_core/services/library_service'), 'getDocuments', () => []);
  const schema = t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'buildSchemaContext', () => { throw new Error('Unexpected schema retrieval'); });
  const embed = t.mock.method(require('../src/backend/services/qdrant_service'), 'embedTexts', () => { throw new Error('Unexpected embedding'); });
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }] }) }));
  const result = await core.chat('hello', { providerId: provider.id, permissions: ['sql:read'], session: { id: 'hello-session', accountId: 'owner' } });
  assert.equal(result.replyText, 'Hello!');
  assert.equal(schema.mock.callCount(), 0); assert.equal(embed.mock.callCount(), 0);
}));

test('schema retrieval is scoped to the chosen SQL source and runs only through its tool', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'admin' });
  const connector = require('../src/backend/services/sql_connector');
  connector.dbSources.push({ id: 'lazy-source', database: 'FixtureDb' });
  t.after(() => { connector.dbSources = connector.dbSources.filter(source => source.id !== 'lazy-source'); });
  const build = t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'buildSchemaContext', async (query, options) => {
    assert.equal(query, 'employee gender'); assert.equal(options.dbSourceId, 'lazy-source'); assert.equal(options.dbName, 'FixtureDb'); assert.equal(options.forceRetrieval, true);
    return { mode: 'data', selectedTables: ['M_Employee'], schemaContext: 'verified schema' };
  });
  const { SearchSchemaTool } = require('../src/backend/agent_core/tools/builtins');
  const request = { operation: 'compare', attributes: ['gender'], presentation: 'table' };
  const result = await new SearchSchemaTool().run({ query: 'employee gender', request }, { governedController: true, dbSourceId: 'lazy-source' });
  assert.equal(build.mock.callCount(), 1); assert.equal(result.schemaContext, 'verified schema');
  assert.deepEqual(result.requestIntent, request);
  assert.ok(governance.current().resources.has('sql:lazy-source'));
}));

test('schema discovery retains configured business descriptions and aggregation defaults', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'admin' });
  const connector = require('../src/backend/services/sql_connector');
  t.mock.method(connector, 'getDefaultDbSource', () => ({ id: 'metadata-source', database: 'FixtureDb' }));
  t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'buildSchemaContext', async () => ({ mode: 'data', selectedTables: ['Costs'], schemaContext: 'schema' }));
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [{ tableName: 'Costs', dbSourceId: 'metadata-source', tableDescription: 'Operating costs', defaultMetric: 'Amount', defaultAggregation: 'SUM', columns: [{ columnName: 'Category', dataType: 'INT', description: 'Maintenance has code 42' }] }]);
  const { SearchSchemaTool } = require('../src/backend/agent_core/tools/builtins');
  const result = await new SearchSchemaTool().run({ query: 'operating costs', request: { operation: 'aggregate', attributes: [], presentation: 'table' } }, { governedController: true });
  assert.equal(result.tables[0].description, 'Operating costs');
  assert.equal(result.tables[0].defaultMetric, 'Amount');
  assert.equal(result.tables[0].defaultAggregation, 'SUM');
  assert.equal(result.tables[0].columns[0].description, 'Maintenance has code 42');
}));

test('knowledge tool searches only documents allowed for the selected model before reading corpus', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'admin' });
  const library = require('../src/backend/knowledge_core/services/library_service');
  const retrieval = require('../src/backend/knowledge_core/services/retrieval_service');
  t.mock.method(library, 'getDocuments', () => [
    { id: 'app', title: 'App guide', governedPolicy: { modelDestinations: ['gemini'] } },
    { id: 'private', title: 'Private guide' }
  ]);
  t.mock.method(library, 'getContent', id => { assert.equal(id, 'app'); return { content: 'Install app' }; });
  t.mock.method(retrieval, 'search', async (query, options) => {
    assert.deepEqual(options.documentIds, ['app']); assert.equal(options.scopeMode, 'selected');
    return { results: [{ payload: { documentId: 'app', fullText: 'Install app' }, score: 1 }] };
  });
  const { SearchKnowledgeTool } = require('../src/backend/agent_core/tools/builtins');
  const result = await new SearchKnowledgeTool().run({ query: 'install' }, { modelDestination: { id: 'gemini', local: false } });
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].documentId, 'app');
}));

test('governed harness never runs deterministic or recovery SQL when provider fails', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  const harness = new Harness({ toolManager: manager, dispatch: async () => { throw Object.assign(new Error('Gemini API: invalid schema'), { status: 400 }); } });
  const result = await harness.run({ userMessage: 'ds nv', provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['list_workflows', 'execute_sql_query'], context: { governedController: true, lockProvider: true, permissions: ['admin'],
      mode: 'data', requestPlan: { table: 'M_Employee', intent: 'list', unfilteredList: true, outputs: { data: true }, schemaColumns: ['EmployeeCode'] } } });
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(result.trace.steps.find(step => step.type === 'PROVIDER_ERROR').status, 400);
  assert.match(result.trace.steps.find(step => step.type === 'PROVIDER_ERROR').error, /invalid schema/);
  assert.ok(!result.trace.steps.some(step => /DETERMINISTIC_LIST|ENRICHED_LIST/.test(step.type)));
});

test('governed harness rejects SQL before successful workflow discovery', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  const harness = new Harness({ toolManager: manager, maxRepairs: 0, dispatch: async () => ({ tool_calls: [
    { id: 'sql-1', type: 'function', function: { name: 'execute_sql_query', arguments: JSON.stringify({ sql: 'SELECT EmployeeCode FROM M_Employee' }) } }
  ] }) });
  const result = await harness.run({ userMessage: 'employee detail', provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['list_workflows', 'execute_sql_query'], context: { governedController: true, lockProvider: true, permissions: ['admin'],
      mode: 'data', requestPlan: { table: 'M_Employee', intent: 'record_lookup', outputs: { data: true }, schemaColumns: ['EmployeeCode'] } } });
  assert.ok(result.trace.steps.some(step => step.type === 'WORKFLOW_DISCOVERY_REQUIRED'));
  assert.ok(result.toolCalls.every(call => !call.success));
  assert.equal(result.trace.executionBudget.sqlAttempts, 0);
});
test('default controller discovers and starts workflow through gateway without TEV1 or legacy orchestrator', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'user' }); governance.current().requestId = 'controller-request';
  const providers = require('../src/backend/services/ai_provider_manager'), automation = require('../src/backend/automation');
  const provider = { id: 'controller-model', name: 'Controller model', model: 'fixture', apiFormat: 'openai', baseUrl: 'http://127.0.0.1:9911', supportsToolCalling: true, contextWindow: 64000 };
  t.mock.method(providers, 'getProviderForExecution', () => provider); t.mock.method(providers, 'getActiveProvider', () => provider);
  t.mock.method(require('../src/backend/automation/chat_router'), 'classifyFlow', () => { throw new Error('Legacy flow router must not run'); });
  t.mock.method(require('../src/backend/automation/chat_router'), 'createRoutingContext', () => { throw new Error('Legacy router config must not be required'); });
  t.mock.method(require('../src/backend/automation/orchestrator'), 'handle', () => { throw new Error('Legacy workflow dispatch must not run'); });
  t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'buildSchemaContext', async () => { throw new Error('Schema retrieval must be requested by the agent'); });
  t.mock.method(require('../src/backend/knowledge_core/services/library_service'), 'getDocuments', () => []);
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async actor => { assert.equal(actor.accountId, 'owner'); return [{ id: 'fixture/employee', name: 'Employee detail', inputs: { employeeId: { schema: { type: 'string' } } }, bindings: {}, packageVersion: 3 }]; });
  t.mock.method(automation.registry, 'getTemplate', async id => { assert.equal(id, 'fixture/employee'); return { bindings: {} }; });
  t.mock.method(automation.runtime, 'pending', async () => null);
  const create = t.mock.method(automation.runtime, 'create', async (id, inputs, actor, options) => {
    assert.equal(id, 'fixture/employee'); assert.deepEqual(inputs, {}); assert.equal(actor.accountId, 'owner'); assert.equal(options.conversationId, 'session');
    return { id: 'run-1', status: 'WAITING_INPUT', revision: 1, packageVersion: 3, missingInputs: [{ key: 'employeeId', schema: { type: 'string' }, ask: 'Employee ID?' }] };
  });
  let calls = 0;
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(String(url).startsWith(provider.baseUrl));
    const body = JSON.parse(options.body), names = body.tools.map(tool => tool.function.name);
    if (names.includes('assess_workflow')) return { ok: true, json: async () => ({ choices: [{ message: {
      content: JSON.stringify({ suitable: true, reason: 'Employee lookup matches the request.' }) }, finish_reason: 'stop' }] }) };
    assert.ok(names.includes('list_workflows'));
    assert.equal(names.includes('run_workflow'), calls > 0);
    assert.match(body.messages[0].content, /bounded task controller/);
    const actions = ++calls === 1 ? [{ name: 'list_workflows', arguments: '{}' }] : [{ name: 'run_workflow', arguments: '{"templateId":"fixture/employee","inputs":{}}' }, { name: 'execute_sql_query', arguments: '{"sql":"SELECT 1"}' }];
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: actions.map((fn, index) => ({ id: `call-${calls}-${index}`, type: 'function', function: fn })) }, finish_reason: 'tool_calls' }] }) };
  });
  const result = await core.chat('tra cứu nhân viên', { providerId: provider.id, knowledgeSearchEnabled: false, permissions: ['sql:read'], session: { id: 'session', accountId: 'owner' } });
  assert.equal(result.success, true); assert.equal(create.mock.callCount(), 1); assert.equal(calls, 2);
  assert.deepEqual(result.toolCalls.map(call => call.toolName), ['list_workflows', 'run_workflow']);
  assert.equal(result.execution.status, 'WAITING_INPUT'); assert.equal(result.execution.templateVersion, 3);
  assert.equal(result.trace.workflowRouting.decisionSource, 'agent_controller'); assert.equal(result.trace.workflowRouting.legacyRoutingSkipped, true);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.equal(governance.current().finalEnvelope.disposition, 'pending');
}));

test('workflow tools reject cross-conversation references and stale admin privileges', async t => governance.run(async () => {
  governance.setPrincipal({ subject: 'account:owner', role: 'user' });
  const tools = require('../src/backend/governance/workflow_tools'), automation = require('../src/backend/automation');
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  const context = { session: { accountId: 'owner', id: 'new-session' }, permissions: ['admin', 'sql:read'] };
  assert.deepEqual(tools.actor(context).permissions, ['sql:read']);
  t.mock.method(automation.runtime, 'owned', async () => ({ id: 'other-run', conversationId: 'old-session' }));
  const cancelled = t.mock.method(automation.runtime, 'cancel', () => { throw new Error('Must not cancel'); });
  await assert.rejects(tools.execute('cancel_workflow', { runId: 'other-run', revision: 1 }, context), { code: 'WORKFLOW_CONVERSATION_MISMATCH' });
  assert.equal(cancelled.mock.callCount(), 0);
}));

test('stored-information description uses verified schema without SQL or a chart contract', async t => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  const question = "Hệ thống lưu những thông tin nào về doanh nghiệp trong khu công nghiệp?";
  t.mock.method(manager.getTool('search_schema'), 'run', async () => ({ mode: 'data', selectedTables: ['M_Customer'],
    requestIntent: { operation: 'describe', attributes: [], presentation: 'text' },
    tables: [{ tableName: 'M_Customer', columns: [{ name: 'CustomerCode' }, { name: 'CustomerName' }, { name: 'TaxCode' }] }] }));
  let calls = 0;
  const harness = new Harness({ toolManager: manager, dispatch: async () => ++calls === 1
    ? { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: JSON.stringify({ query: 'doanh nghiệp', request: { operation: 'describe', attributes: [], presentation: 'text' } }) } }] }
    : { content: 'Theo cấu trúc M_Customer, hệ thống lưu mã doanh nghiệp, tên doanh nghiệp và mã số thuế.' } });
  const result = await harness.run({ userMessage: question, provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['search_schema'], context: { governedController: true, lockProvider: true, mode: 'general' } });
  assert.equal(calls, 2);
  assert.equal(result.trace.executionBudget.sqlAttempts, 0);
  assert.equal(result.trace.executionBudget.repairAttempts, 0);
  assert.equal(result.trace.training.responseEvaluation.valid, true);
  assert.equal(result.trace.requestContract, null);
  assert.ok(result.replyText.length > 20);
});


test('schema discovery preserves a resolved explanation instead of requiring record SQL', async t => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  t.mock.method(require('../src/backend/memory_core/conversation_resolver'), 'resolve', async () => ({
    relation: 'independent', operation: 'conversation', cardinality: 'none', attributes: [], selectedIds: [],
    selected: [], clarification: null, dataUse: 'none', sourceScope: 'enterprise'
  }));
  t.mock.method(manager.getTool('search_schema'), 'run', async () => ({ mode: 'data', selectedTables: ['M_Customer'],
    tables: [{ tableName: 'M_Customer', columns: [{ name: 'CustomerGroupID' }] }] }));
  let calls = 0;
  const harness = new Harness({ toolManager: manager, dispatch: async () => ++calls === 1
    ? { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: '{"query":"customer classification criteria"}' } }] }
    : { content: '<final_answer>Configured customer group is one available classification criterion.</final_answer>' } });
  const result = await harness.run({ userMessage: 'Which criteria can classify customers?', provider: { id: 'fixture', supportsToolCalling: true },
    enabledToolNames: ['search_schema'], context: { governedController: true, lockProvider: true, mode: 'general',
      resolutionContext: { recent: [{ role: 'user', content: 'Earlier schema question' }] } } });
  assert.equal(calls, 2);
  assert.equal(result.trace.training.responseEvaluation.valid, true);
  assert.equal(result.trace.executionBudget.sqlAttempts, 0);
  assert.equal(result.trace.executionBudget.repairAttempts, 0);
  assert.doesNotMatch(result.replyText, /final_answer/);
});

test('configured detail segment anchors aggregate root and structured SQL passes existing guards',async t=>{
 const Harness=require('../src/backend/agent_core/harness/guarded_agent_harness'),manager=require('../src/backend/agent_core').defaultToolManager;
 const semanticModel={version:1,kind:'detail',entity:'Costs',grain:'One cost',identityFields:['ID'],summaryFields:['ID','Amount'],segments:[{id:'operations',label:'Operations',column:'Category',value:21}]};
 const tables=[{tableName:'Parent',dbSourceId:'fixture-source',isActive:true,domain:'electricity',columns:[{columnName:'ID',dataType:'INT',isPrimaryKey:true}]},
  {tableName:'Costs',dbSourceId:'fixture-source',isActive:true,semanticModel,columns:[{columnName:'ID',dataType:'INT',isPrimaryKey:true},{columnName:'Category',dataType:'INT',description:'operations Category = 21'},{columnName:'Amount',dataType:'INT'}]}];
 t.mock.method(require('../src/backend/services/dictionary_service'),'getGroupedTables',()=>tables);
 t.mock.method(manager.getTool('list_workflows'),'run',async()=>({workflows:[]}));
 t.mock.method(manager.getTool('search_schema'),'run',async()=>({mode:'data',dbSourceId:'fixture-source',selectedTables:['Parent','Costs'],requestIntent:{operation:'list',attributes:['Invented'],presentation:'table'},
  intentCatalog:tables.map(table=>({tableName:table.tableName,schemaName:'dbo',columns:table.columns.map(c=>({name:c.columnName}))})),
  tables:tables.map(table=>({...table,columns:table.columns.filter(c=>c.columnName==='ID').map(c=>({name:c.columnName,type:c.dataType,description:c.description}))}))}));
 t.mock.method(manager.getTool('execute_sql_query'),'run',async args=>({rows:[{SUM_Amount:12}],rowCount:1,sql:args.sql}));
 const tool=(name,args)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const harness=new Harness({toolManager:manager,dispatch:async(provider,messages,defs)=>{
  if(messages[0]?.content?.startsWith('Return JSON only with operation')) {
   assert.ok(JSON.parse(messages.at(-1).content).tables.find(table=>table.tableName==='Costs').columns.some(c=>c.name==='Amount'));
   return {content:JSON.stringify({operation:'aggregate',analysis:'none',attributes:[],presentation:'table',dataQuery:{table:'Costs',operation:'aggregate',segment:'operations',measures:[{column:'Amount',aggregation:'SUM'}]}})};
  }
  if(!defs.length)return {content:JSON.stringify({filters:[{table:'Costs',column:'Category',value:21,evidence:'Category = 21'}]})};
  if(!messages.some(m=>m.role==='tool'))return {tool_calls:[tool('list_workflows',{}),tool('search_schema',{query:'electricity operations',request:{operation:'aggregate',attributes:[],presentation:'table'}})]};
  return {tool_calls:[tool('execute_sql_query',{query:{table:'Costs',operation:'aggregate',segment:'operations',measures:[{column:'Amount',aggregation:'SUM'}]}})]};
 }});
 const result=await harness.run({userMessage:'statistics electricity operations',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['list_workflows','search_schema','execute_sql_query'],context:{governedController:true,lockProvider:true,mode:'data',dbSourceId:'fixture-source',permissions:['sql:read']}});
 assert.equal(result.trace.completionStatus,'SUCCESS');
 assert.ok(result.trace.steps.some(step=>step.type==='SEMANTIC_QUERY_COMPILED'));
 assert.ok(result.trace.steps.some(step=>step.type==='SEMANTIC_INTENT_REVIEWED'));
 assert.ok(result.trace.steps.some(step=>step.type==='SEMANTIC_PLAN_DISPATCHED'));
 assert.ok(!result.trace.steps.some(step=>step.type==='WRONG_TABLE'));
 assert.match(result.replyText,/12/);
});
