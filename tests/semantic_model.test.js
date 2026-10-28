'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../src/backend/services/semantic_model'),query=require('../src/backend/services/semantic_query');
const table=()=>({tableName:'Records',schemaName:'dbo',isActive:true,columns:[{columnName:'ID',dataType:'int',isPrimaryKey:true},{columnName:'Code',dataType:'nvarchar'},{columnName:'Name',dataType:'nvarchar'},{columnName:'Amount',dataType:'decimal'},{columnName:'Category',dataType:'int'},{columnName:'Private',isVisible:false}],semanticModel:{version:1,entity:'Record',grain:'One record',identityFields:['ID'],summaryFields:['ID','Code','Name'],segments:[{id:'operations',label:'Operations',column:'Category',value:21}]}});

test('age superlatives retain ties with the same mandatory and user scope in the extreme subquery',()=> {
 const t=table();t.columns.push({columnName:'BirthDate',dataType:'datetime'});
 const input={table:'Records',operation:'list',limit:1,fields:['Name'],segment:'operations',
  filters:[{column:'Code',operator:'in',values:['A','B']}],
  ranking:{kind:'youngest',subject:'employee',column:'BirthDate',identityColumns:['Name','Code']}};
 const result=query.compile(input,[t]);
 assert.ok(result.sql.includes('SELECT TOP 100'));
 assert.ok(result.sql.includes('[BirthDate] = (SELECT MAX([BirthDate]) FROM [dbo].[Records] WHERE'));
 assert.equal(result.sql.split('[Category] = 21').length,3);
 assert.equal(result.sql.split("[Code] IN (N'A', N'B')").length,3);
 assert.ok(result.sql.includes('[BirthDate] IS NOT NULL'));
 assert.equal(result.ranking.sql,result.sql);
 assert.equal(require('../src/backend/assistant/security_guard').validateSqlQuery(result.sql).safe,true);
 assert.ok(query.compile({...input,ranking:{...input.ranking,kind:'oldest'}},[t]).sql.includes('SELECT MIN([BirthDate])'));
 assert.throws(()=>query.compile({...input,ranking:{...input.ranking,column:'Private'}},[t]),{code:'SEMANTIC_RANKING_INVALID'});
 assert.throws(()=>query.compile({...input,ranking:{...input.ranking,identityColumns:['Private']}},[t]),{code:'SEMANTIC_FIELD_UNAVAILABLE'});
 assert.throws(()=>query.compile({...input,orderBy:[{column:'BirthDate',direction:'ASC'}]},[t]),{code:'SEMANTIC_RANKING_SORT_CONFLICT'});
});
test('ranked record queries preserve date sorting and exclude unknown dates',()=> {
 const t=table();t.columns.push({columnName:'BirthDate',dataType:'datetime'});
 const input={table:'Records',operation:'list',fields:['Code','Name','BirthDate'],limit:1,
  filters:[{column:'BirthDate',operator:'isNotNull'}],orderBy:[{column:'BirthDate',direction:'DESC'}]};
 const result=query.compile(input,[t]);
 assert.match(result.sql,/TOP 1/);assert.match(result.sql,/WHERE \[BirthDate\] IS NOT NULL ORDER BY \[BirthDate\] DESC$/);
 assert.equal(require('../src/backend/assistant/security_guard').validateSqlQuery(result.sql).safe,true);
 assert.match(query.compile({...input,orderBy:[{column:'BirthDate',direction:'ASC'}]},[t]).sql,/ORDER BY \[BirthDate\] ASC$/);
 assert.throws(()=>query.compile({...input,orderBy:[{column:'Private',direction:'DESC'}]},[t]),{code:'SEMANTIC_FIELD_UNAVAILABLE'});
 assert.throws(()=>query.compile({...input,orderBy:[{column:'BirthDate',direction:'DESC; DROP TABLE Records'}]},[t]),{code:'SEMANTIC_QUERY_INVALID'});
});
test('semantic table resolution accepts authorized qualified/case/semantic names but never guesses or crosses ambiguous schemas',()=>{
 for(const name of ['Records','records','dbo.Records','[dbo].[Records]','[Records]','Record']) {
  const result=query.compile({table:name,operation:'list'},[table()]);
  assert.ok(result.sql.includes('[dbo].[Records]'));
  assert.ok(!result.sql.includes('Private'));
 }
 assert.throws(()=>query.compile({table:'Records',operation:'list'},[table(),{...table(),schemaName:'other'}]),{code:'SEMANTIC_TABLE_AMBIGUOUS_OR_UNAVAILABLE'});
 assert.ok(query.compile({table:'dbo.Records',operation:'list'},[table(),{...table(),schemaName:'other'}]).sql.includes('[dbo].[Records]'));
 for(const name of ['OtherTable','dbo.Records; DROP TABLE Records','Unknown entity'])
  assert.throws(()=>query.compile({table:name,operation:'list'},[table()]),{code:'SEMANTIC_TABLE_AMBIGUOUS_OR_UNAVAILABLE'});
 assert.throws(()=>query.compile({table:'Records',operation:'list'},[{...table(),isActive:false}]),{code:'SEMANTIC_TABLE_AMBIGUOUS_OR_UNAVAILABLE'});
});
test('semantic config rejects hidden columns, unknown rules and duplicate segment IDs',()=>{
 const t=table();assert.deepEqual(model.validateModel(t.semanticModel,t),t.semanticModel);
 assert.throws(()=>model.validateModel({...t.semanticModel,identityFields:['Private']},t),{code:'SEMANTIC_COLUMN_UNAVAILABLE'});
 assert.throws(()=>model.validateModel({...t.semanticModel,segments:[...t.semanticModel.segments,...t.semanticModel.segments]},t),{code:'SEMANTIC_SEGMENT_DUPLICATE'});
 assert.throws(()=>model.validateModel({...t.semanticModel,sql:'DROP'},t),{code:'SEMANTIC_MODEL_INVALID'});
});
test('context projection preserves mappings/joins and distinguishes deferred from hidden',()=>{
 const t=table();t.columns.push({columnName:'LegacyMapping',description:'Category = 9'});
 const r=model.project([t],{operation:'list',attributes:[]}).tables[0];
 assert.equal(r.excludedColumnCount,1);assert.equal(r.deferredColumnCount,1);
 assert.deepEqual(r.columns.map(c=>c.name),['ID','Code','Name','Category','LegacyMapping']);
 assert.match(r.contextInstruction,/deferred/);
 const full=model.project([t],{operation:'detail',attributes:[]}).tables[0];assert.equal(full.deferredColumnCount,0);
 const unresolved=model.project([t],{operation:'aggregate',attributes:['business synonym']}).tables[0];assert.equal(unresolved.deferredColumnCount,0);
});
test('metadata cache invalidates on visibility, business mapping, relationship and principal changes',()=>{
 const t=table(),intent={operation:'list',attributes:[]},scope={principal:'A'};
 const a=model.project([t],intent,[],scope);assert.equal(model.project([t],intent,[],scope).cacheHit,true);
 const b=model.project([t],intent,[],{principal:'B'});assert.notEqual(a.contextRevision,b.contextRevision);
 t.columns[3].isVisible=false;assert.notEqual(model.project([t],intent,[],scope).contextRevision,a.contextRevision);
 assert.notEqual(model.project([table()],intent,[{revision:2}],scope).contextRevision,a.contextRevision);
 a.tables[0].columns=[];assert.ok(model.project([table()],intent,[],scope).tables[0].columns.length);
});
test('structured queries add identity and configured segment while escaping user values',()=>{
 const compiled=query.compile({table:'Records',operation:'list',segment:'operations',filters:[{column:'Name',operator:'eq',value:"O'Brien"}]},[table()]);
 assert.match(compiled.sql,/\[ID\], \[Code\], \[Name\]/);assert.match(compiled.sql,/\[Category\] = 21/);assert.match(compiled.sql,/O''Brien/);
 const ast=new(require('node-sql-parser').Parser)().astify(compiled.sql,{database:'TransactSQL'});assert.equal(ast.type,'select');
});
test('comparison filters support bounded IN values without expanding SQL scope',()=>{
 const r=query.compile({table:'Records',operation:'compare',fields:['Code','Name'],filters:[{column:'Code',operator:'in',values:['A','B']}]},[table()]);
 assert.match(r.sql,/\[Code\] IN \(N'A', N'B'\)/);
 assert.throws(()=>query.compile({table:'Records',operation:'compare',fields:['Code'],filters:[{column:'Code',operator:'in',values:[]}]},[table()]));
});
test('SQL tool normalizes legacy query text and sql wrapper before strict plan validation',()=>{
 const manager=require('../src/backend/agent').defaultToolManager;
 const {validateToolCall}=require('../src/backend/agent/harness/tool_argument_validator');
 for(const query of ['SELECT ID FROM Records',{sql:'SELECT ID FROM Records'}]) {
  const r=validateToolCall(manager,{name:'execute_sql_query',arguments:{query}});
  assert.equal(r.valid,true);assert.equal(r.args.sql,'SELECT ID FROM Records');
 }
 const plan={table:'Records',operation:'list'};
 assert.deepEqual(validateToolCall(manager,{name:'execute_sql_query',arguments:{dataQuery:plan,sql:null}}).args,{dataQuery:plan});
 assert.equal(validateToolCall(manager,{name:'execute_sql_query',arguments:{sql:'SELECT ID FROM Records',query:'SELECT Name FROM Records'}}).valid,false);
 assert.equal(validateToolCall(manager,{name:'execute_sql_query',arguments:{dataQuery:{sql:'SELECT ID FROM Records'}}}).valid,false);
 const legacy=validateToolCall(manager,{name:'execute_sql_query',arguments:{dataQuery:{rootTable:'Records',intent:'list',segment:null,time:null,filters:[{field:'Code',operator:'eq',value:'A'}]}}});
 assert.equal(legacy.valid,true);assert.deepEqual(legacy.args.dataQuery,{table:'Records',operation:'list',filters:[{column:'Code',operator:'eq',value:'A'}]});
});
test('undeclared comparison/statistics workflow cannot hijack a SQL task',async()=>{
 const assess=require('../src/backend/memory/workflow_suitability').assess;
 for(const operation of ['compare','aggregate','attribute'])await assert.rejects(assess(()=>{throw Error('Must not call model')},'request',{operation},{tags:[]}),{code:'WORKFLOW_OPERATION_MISMATCH'});
 const select=require('../src/backend/agent/harness/staged_tools').select;
 const definitions=[{function:{name:'run_workflow'}},{function:{name:'execute_sql_query'}}];
 assert.deepEqual(select(definitions,{completed:['list_workflows','search_schema'],operation:'compare'}).map(t=>t.function.name),['execute_sql_query']);
 assert.equal(select(definitions,{catalog:true,operation:'compare',workflowOperations:['compare']}).some(t=>t.function.name==='run_workflow'),true);
});
test('compiler includes validated mandatory record fields on first SQL and refuses mapped JOIN criteria',()=>{
 const contract={operation:'list',attributes:[{name:'Amount'}],completeness:{unresolved:[]}};
 assert.match(query.compile({table:'Records',operation:'list'},[table()],{},contract).sql,/\[Amount\]/);
 contract.attributes[0].mappedSource={table:'Lookup',column:'Name'};
 assert.throws(()=>query.compile({table:'Records',operation:'list'},[table()],{},contract),{code:'SEMANTIC_JOIN_REQUIRED'});
});
test('raw simple record SELECT gains missing required identity before execution without changing filters',()=>{
 const contract={operation:'compare',attributes:[{name:'ID',resultKeys:['ID']},{name:'Name',resultKeys:['Name']}],completeness:{unresolved:[]}};
 const input="SELECT Name FROM Records WHERE Code IN ('A','B')";
 const output=query.completeProjection(input,contract,'Records',['ID','Code','Name']);
 assert.deepEqual(output.addedColumns,['ID']);
 const parser=new(require('node-sql-parser').Parser)();
 assert.deepEqual(parser.astify(output.sql,{database:'TransactSQL'}).where,parser.astify(input,{database:'TransactSQL'}).where);
 for(const sql of ['SELECT DISTINCT Name FROM Records','SELECT COUNT(ID) AS Total FROM Records','SELECT a.Name FROM Records a JOIN Other b ON a.ID=b.ID'])assert.equal(query.completeProjection(sql,contract,'Records',['ID','Name']).sql,sql);
});
test('unspecified lists use configured summary rather than model-added profile fields',()=>{
 const contract={operation:'list',attributes:[{name:'ID',resultKeys:['ID']},{name:'Code',resultKeys:['Code']}],completeness:{mode:'identity_fields',unresolved:[]}};
 const result=query.compile({table:'Records',operation:'list',fields:['Name','Amount']},[table()],{},contract);
 assert.match(result.sql,/\[ID\], \[Code\] FROM/);assert.ok(!result.sql.includes('[Amount]'));
 const raw=query.completeProjection('SELECT ID, Code, Amount FROM Records WHERE Amount > 1',contract,'Records',['ID','Code','Amount']);
 assert.ok(!raw.sql.split('FROM')[0].includes('Amount'));assert.ok(raw.sql.includes('Amount'));
});
test('query compiler rejects unavailable fields, ambiguous tables, unsupported JOIN scopes and nonnumeric SUM',()=>{
 const t=table();
 for(const input of [{table:'Records',operation:'list',fields:['Private']},{table:'Records',operation:'aggregate',measures:[{column:'Name',aggregation:'SUM'}]},{table:'Records',operation:'list',segment:'fake'}])assert.throws(()=>query.compile(input,[t]));
 assert.throws(()=>query.compile({table:'Records',operation:'list'},[t,t]),{code:'SEMANTIC_TABLE_AMBIGUOUS_OR_UNAVAILABLE'});
 assert.throws(()=>query.compile({table:'Records',operation:'list'},[t],{filters:[{table:'Other',column:'Category',value:21}]}),{code:'SEMANTIC_JOIN_REQUIRED'});
});
test('aggregate groups requested dimensions and retains verified category scope',()=>{
 const r=query.compile({table:'Records',operation:'aggregate',dimensions:['Code'],measures:[{column:'Amount',aggregation:'SUM'}]},[table()],{filters:[{table:'Records',column:'Category',value:21}]});
 assert.match(r.sql,/SUM\(\[Amount\]\)/);assert.match(r.sql,/WHERE \[Category\] = 21 GROUP BY \[Code\]/);
});
test('reviewed root monetary aggregate completes a record projection without changing joins or filters',()=>{
 const input={table:'Records',operation:'aggregate',measures:[{column:'Amount',aggregation:'SUM'}]};
 const sql="SELECT r.ID, r.Amount, c.Name FROM Records r LEFT JOIN Customers c ON r.CustomerID=c.ID WHERE c.Code='C002' AND r.RecordedAt>='2024-02-01' AND r.RecordedAt<'2024-03-01'";
 const output=query.completeAggregation(sql,input,[table()]);
 assert.equal(output.completed,true);
 const parser=new(require('node-sql-parser').Parser)(),before=parser.astify(sql,{database:'TransactSQL'}),after=parser.astify(output.sql,{database:'TransactSQL'});
 assert.deepEqual(after.from,before.from);assert.deepEqual(after.where,before.where);
 assert.equal(after.columns[0].expr.name,'SUM');assert.equal(after.columns[0].expr.args.expr.table,'r');
 assert.equal(query.completeAggregation(sql,{...input,table:'Other'},[table()]).completed,false);
 assert.equal(query.completeAggregation(sql,{...input,measures:[{column:'Name',aggregation:'SUM'}]},[table()]).completed,false);
 assert.equal(query.completeAggregation('SELECT SUM(Amount) AS Total FROM Records',input,[table()]).completed,false);
});
test('configured segment predicates deduplicate and conflicting categories fail before SQL',()=>{
 const input={table:'Records',operation:'aggregate',segment:'operations',measures:[{column:'Amount',aggregation:'SUM'}]};
 const scope={filters:[{table:'Records',column:'Category',value:21}]};
 assert.equal(query.compile(input,[table()],scope).sql.split('[Category] = 21').length,2);
 assert.throws(()=>query.compile({...input,filters:[{column:'Category',operator:'eq',value:22}]},[table()],scope),{code:'SEMANTIC_FILTER_CONFLICT'});
});
test('trend compiler groups calendar months at source, not from preview rows',()=>{
 const t=table();t.columns.push({columnName:'RecordedAt',dataType:'datetime'});
 const r=query.compile({table:'Records',operation:'aggregate',time:{column:'RecordedAt',grain:'month'},measures:[{column:'Amount',aggregation:'SUM'}],filters:[{column:'RecordedAt',operator:'gte',value:'2026-01-01'},{column:'RecordedAt',operator:'lt',value:'2027-01-01'}]},[t]);
 assert.match(r.sql,/DATEFROMPARTS\(YEAR\(\[RecordedAt\]\), MONTH\(\[RecordedAt\]\), 1\)/);
 assert.match(r.sql,/ORDER BY \[period\]/);
 assert.equal(require('../src/backend/assistant/security_guard').validateSqlQuery(r.sql).safe,true);
});
test('contains filters treat wildcards and quote characters as literal user data',()=>{
 const r=query.compile({table:'Records',operation:'list',filters:[{column:'Name',operator:'contains',value:"%' OR 1=1 --"}]},[table()]);
 const ast=new(require('node-sql-parser').Parser)().astify(r.sql,{database:'TransactSQL'});
 assert.equal(ast.type,'select');assert.equal(ast.where.operator,'LIKE');
 assert.ok(r.sql.includes("[%]'' OR 1=1 --"));
});
test('currency is configurable, defaults to VNĐ for configured money fields, and never labels COUNT as money',()=>{
 const t=table();t.semanticModel.monetaryFields=['Amount'];
 const input={table:'Records',operation:'aggregate',measures:[{column:'Amount',aggregation:'SUM'},{column:'ID',aggregation:'COUNT'}]};
 assert.deepEqual(query.compile(input,[t]).units,{SUM_Amount:'VNĐ'});
 t.semanticModel.defaultCurrency='USD';assert.deepEqual(query.compile(input,[t]).units,{SUM_Amount:'USD'});
 assert.deepEqual(query.inferUnits('SELECT SUM(Amount) AS Total, COUNT(ID) AS CountRows FROM dbo.Records',[t]),{Total:'USD'});
 assert.deepEqual(query.inferUnits('SELECT SUM(a.Amount) AS Total FROM Records a JOIN Other b ON a.ID=b.ID',[t]),{});
 assert.equal(require('../src/backend/agent/harness/grounded_reply').buildSqlRowsFallbackReply({result:{rows:[{SUM_Amount:12}],units:{SUM_Amount:'USD'}}}).includes('USD'),true);
});
test('structured tool flags default capped records while respecting an explicit requested row limit',async t=>{
 const inputTable={...table(),dbSourceId:'fixture'};
 t.mock.method(require('../src/backend/services/dictionary_service'),'getGroupedTables',()=>[inputTable]);
 t.mock.method(require('../src/backend/services/sql_connector'),'executeSqlQuery',async()=>Array.from({length:100},(_,i)=>({ID:i,Code:String(i),Name:'Record'})));
 const tool=new(require('../src/backend/agent/tools/builtins').ExecuteSqlTool)();
 const a=await tool.run({query:{table:'Records',operation:'list'}},{dbSourceId:'fixture'});assert.equal(a.hasMore,true);
 const b=await tool.run({query:{table:'Records',operation:'list',limit:100}},{dbSourceId:'fixture',requestPlan:{requestedRowLimit:100}});assert.equal(b.hasMore,false);
});
