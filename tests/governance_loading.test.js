'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('governance GETs load only dependencies while mutations retain their full scope',()=>{
 const {requestStores}=require('../src/backend/storage/request_stores');
 const files=requestStores({method:'GET',url:'/api/governance/resources'});
 for(const file of ['accounts.json','sessions.json','account_roles.json','account_function_groups.json','db_sources.json','library.json','ai_providers.json'])assert.ok(files.includes(file));
 assert.ok(!files.includes('chat_history.json'));
 assert.deepEqual(requestStores({method:'GET',url:'/api/governance/operations'}),['accounts.json','sessions.json','account_roles.json','account_function_groups.json']);
 assert.deepEqual(requestStores({method:'GET',url:'/api/governance/metrics'}),['accounts.json','sessions.json','account_roles.json','account_function_groups.json','db_sources.json']);
 assert.equal(requestStores({method:'PUT',url:'/api/governance/resources'}),undefined);
});
test('slow operations do not delay resource selection or metric loading',async()=>{
 const events=[],elements=new Map();
 const element=()=>({children:[],value:'',textContent:'',replaceChildren(...nodes){this.children=nodes;},append(...nodes){this.children.push(...nodes);}});
 const context=vm.createContext({window:{},document:{addEventListener(){},querySelectorAll:()=>[],getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element},fetch:async()=>{events.push('resources');return {ok:true,json:async()=>({resources:[],providers:[]})};}});
 vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance.js','utf8'),context);
 let finishOperations;
 context.window.loadAgentOperations=()=>{events.push('operations');return new Promise(resolve=>finishOperations=resolve);};
 context.window.loadGovernedMetrics=async()=>{events.push('metrics');};
 const request=context.window.loadGovernanceResources();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,['operations','resources','metrics']);
 finishOperations();await request;
});
test('projected operations preserve encrypted usage at original step indices',async t=>{
 const storage=require('../src/backend/storage'),pools=require('../src/backend/storage/postgres/pool');
 const previous=process.env.APP_DATA_ENCRYPTION_KEY;process.env.APP_DATA_ENCRYPTION_KEY='ab'.repeat(32);
 t.after(()=>{if(previous===undefined)delete process.env.APP_DATA_ENCRYPTION_KEY;else process.env.APP_DATA_ENCRYPTION_KEY=previous;});
 const {encrypt}=require('../src/backend/storage/postgres/crypto');
 const input=encrypt(12,'chat_runs/a/requestPayload/diagnostics/steps/2/inputTokens');
 const output=encrypt(4,'chat_runs/a/requestPayload/diagnostics/steps/2/outputTokens');
 const client={query:async sql=>({rows:sql.includes('FROM app.tool_executions')?[{parent_id:'a',code:'DENIED'}]:[{id:'a',status:'PARTIAL',latencyMs:40,modelName:'model',assessment:{complete:false},usage:null,steps:[{index:2,type:'MODEL_USAGE',model:'model',inputTokens:input,outputTokens:output}]}]})};
 t.mock.method(storage,'enabled',()=>true);t.mock.method(storage,'getPool',()=>client);
 t.mock.method(pools,'transaction',async(pool,fn)=>fn(pool));
 const operations=require('../src/backend/governance/operations');
 const raw=[{id:'a',status:'PARTIAL',latencyMs:40,modelName:'model',question:'private',requestPayload:{answerEnvelope:{requestAssessment:{complete:false}},diagnostics:{steps:[{type:'OTHER'},{type:'OTHER'},{type:'MODEL_USAGE',model:'model',inputTokens:12,outputTokens:4}]},toolCalls:[{code:'DENIED'}]}}];
 const projected=await operations.loadAudits();
 assert.deepEqual(operations.summarize(projected),operations.summarize(raw));
 assert.ok(!JSON.stringify(projected).includes('private'));
});


test('function group reads exclude unrelated stores and concurrent UI loads share one request', async () => {
 const {requestStores}=require('../src/backend/storage/request_stores');
 assert.deepEqual(requestStores({method:'GET',url:'/api/governance/function-groups'}),['accounts.json','sessions.json','account_roles.json','account_function_groups.json','db_sources.json','library.json','watchfolders.json']);
 const elements=new Map();let calls=0,finish;
 const context=vm.createContext({window:{DG:{esc:String,api:()=>{calls++;return new Promise(resolve=>finish=resolve);}}},document:{getElementById(id){if(!elements.has(id))elements.set(id,{hidden:true,value:'',textContent:'',innerHTML:'',setAttribute(name,value){this[name]=value;},classList:{toggle(){}}});return elements.get(id);},addEventListener(){}}});
 vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance_groups.js','utf8'),context);
 const first=context.window.loadFunctionGroups(),second=context.window.loadFunctionGroups();
 assert.equal(first,second);assert.equal(calls,1);
 assert.match(elements.get('dg-groups-cards').innerHTML,/dg-skeleton-card/);
 assert.match(elements.get('dg-roles-cards').innerHTML,/dg-skeleton-card/);
 assert.equal(elements.get('dg-panel-groups')['aria-busy'],'true');
 finish({groups:[],roles:[],catalog:{sql:[]}});await first;
 assert.equal(elements.get('dg-panel-groups')['aria-busy'],'false');
 assert.doesNotMatch(elements.get('dg-groups-cards').innerHTML,/dg-skeleton-card/);
 const refresh=context.window.loadFunctionGroups();assert.equal(calls,2);
 finish({groups:[],roles:[],catalog:{sql:[]}});await refresh;
});


test('inspection paginates resources and SQL tables without fetching again',async()=>{
 const elements=new Map();let calls=0;
 const tables=Array.from({length:23},(_,i)=>({name:`table_${i}`,level:'full'}));
 const resources=Array.from({length:21},(_,i)=>({name:`source_${i}`,type:'sql',allowed:true,reason:'ADMIN',via:[],tables,aiLevel:'all',ai:[]}));
 const context=vm.createContext({window:{DG:{esc:String,LABELS:{type:{sql:'SQL'},level:{full:'Full'},ai:{all:'All'}},api:async()=>{calls++;return {actor:{label:'Admin',role:'admin',functionGroups:[],workflows:[]},resources};}}},document:{getElementById(id){if(!elements.has(id))elements.set(id,{value:'role=admin',innerHTML:''});return elements.get(id);},addEventListener(){}}});
 vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance_groups.js','utf8'),context);
 await context.window.inspectGovernanceActor();
 const box=elements.get('dg-inspect-result');
 assert.match(box.innerHTML,/1&ndash;10 \/ 21/);
 assert.match(box.innerHTML,/source_9</);assert.doesNotMatch(box.innerHTML,/source_10</);
 assert.match(box.innerHTML,/table_9</);assert.doesNotMatch(box.innerHTML,/table_10</);
 context.window.pageInspectTables(0,3);
 const detail=elements.get('dg-inspect-table-page-0');
 assert.match(detail.innerHTML,/table_22</);assert.doesNotMatch(detail.innerHTML,/table_19</);
 context.window.pageInspectResources(3);
 assert.match(box.innerHTML,/source_20</);assert.doesNotMatch(box.innerHTML,/source_19</);
 assert.equal(calls,1);
});


test('source pagination stays visible, resets on filtering and selects only the current page',()=>{
 const elements=new Map();
 const context=vm.createContext({window:{},document:{addEventListener(){},getElementById(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:''});return elements.get(id);}}});
 vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance.js','utf8'),context);
 context.window.DG.state.data={resources:Array.from({length:12},(_,i)=>({name:`source_${i}`,id:String(i),type:'sql',policy:{access:{mode:'all',denyUsers:[]},aiSharing:{level:'all'},sql:{packages:[],hiddenTables:[]}},functionGroups:[]}))};
 context.window.renderGovernanceSources();
 assert.match(elements.get('dg-sources-pagination').innerHTML,/Trang 1\/2/);
 context.window.pageGovernanceSources(2);
 context.window.toggleGovernanceSelectAll(true);
 assert.deepEqual([...context.window.DG.state.selected],[10,11]);
 elements.get('dg-search').value='source_11';context.window.renderGovernanceSources();
 assert.match(elements.get('dg-sources-pagination').innerHTML,/Trang 1\/1/);
 assert.match(elements.get('dg-sources-body').innerHTML,/source_11/);
});
