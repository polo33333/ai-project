'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const storage=require('../src/backend/storage'),pools=require('../src/backend/storage/postgres/pool');
const reader=require('../src/backend/services/audit_reader');
test('audit details retain ordered tool executions and enforce account ownership',async t=>{
 t.mock.method(storage,'enabled',()=>true);
 const payload={id:'a',question:'Question',requestPayload:{principalRef:'account:owner',diagnostics:{steps:[{type:'test'}]}}};
 const client={query:async sql=>({rows:sql.includes('app.tool_executions')?[{id:'child',parent_id:'a',payload:{name:'execute_sql_query',result:{rows:[{Value:2}]}}}]:[{id:'a',payload:structuredClone(payload),child_fields:['requestPayload.toolCalls']}]})};
 t.mock.method(storage,'getPool',()=>client);t.mock.method(pools,'transaction',async(pool,fn)=>fn(pool));
 const detail=await reader.detail('a',{id:'owner',role:'user'});
 assert.equal(detail.requestPayload.toolCalls[0].result.rows[0].Value,2);
 await assert.rejects(reader.detail('a',{id:'other',role:'user'}),error=>error.statusCode===404);
 assert.equal((await reader.detail('a',{id:'admin',role:'admin'})).question,'Question');
 payload.requestPayload={memoryDecision:{accountId:'legacy-owner'}};
 assert.equal((await reader.detail('a',{id:'legacy-owner',role:'user'})).id,'a');
});
test('audit list reads lightweight columns with owner predicates and without diagnostic payloads',async t=>{
 t.mock.method(storage,'enabled',()=>true);
 let request;
 t.mock.method(storage,'getPool',()=>({query:async(sql,args)=>{request={sql,args};return {rows:[]};}}));
 await reader.list({id:'owner',role:'user'});
 assert.deepEqual(request.args,[false,'account:owner','owner']);
 assert.match(request.sql,/principalRef/);assert.doesNotMatch(request.sql,/diagnostics|SELECT \*/);
});
test('history JSON is requested on first open and retained while toggling',async()=>{
 const source=fs.readFileSync('src/frontend/admin-client/js/modules/chat_history.js','utf8');
 let requests=0;let copyHandler;const host={textContent:'',innerHTML:'',setAttribute(){},removeAttribute(){},querySelector:()=>({addEventListener(type,handler){assert.equal(type,'click');copyHandler=handler;}})};
 const panel={open:false,dataset:{auditId:'a'},querySelector:()=>host};
 const context=vm.createContext({window:{},fetch:async()=>{requests++;return {ok:true,json:async()=>({id:'a',question:'<script>',requestPayload:{toolCalls:[{name:'SQL'}]}})};}});
 vm.runInContext(source,context);
 await context.loadChatAuditDetails(panel);assert.equal(requests,0);
 panel.open=true;await context.loadChatAuditDetails(panel);assert.equal(requests,1);
 assert.ok(host.innerHTML.includes('&lt;script&gt;'));assert.ok(!host.innerHTML.includes('<script>'));
 assert.ok(host.innerHTML.includes('Copy JSON'));assert.equal(typeof copyHandler,'function');
 panel.open=false;await context.loadChatAuditDetails(panel);panel.open=true;await context.loadChatAuditDetails(panel);assert.equal(requests,1);
});
