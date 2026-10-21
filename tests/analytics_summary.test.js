'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const storage=require('../src/backend/storage');
const summary=require('../src/backend/services/analytics_summary');
test('summary requests load authentication without reconstructing chat/tool history',()=>{
 const {requestStores}=require('../src/backend/storage/request_stores');
 for(const route of ['chat-history','chat-feedback']) {
  assert.deepEqual(requestStores({method:'GET',url:`/api/${route}?summary=1`}),['accounts.json','sessions.json','account_roles.json']);
  assert.ok(requestStores({method:'GET',url:`/api/${route}`}).includes('chat_history.json'));
 }
});
test('history summary retains encrypted token totals and owner filtering without transcripts',async t=>{
 const previous=process.env.APP_DATA_ENCRYPTION_KEY;process.env.APP_DATA_ENCRYPTION_KEY='ab'.repeat(32);
 t.after(()=>{if(previous===undefined)delete process.env.APP_DATA_ENCRYPTION_KEY;else process.env.APP_DATA_ENCRYPTION_KEY=previous;});
 const usage=require('../src/backend/storage/postgres/crypto').encrypt({totalTokens:742,inputTokens:600},'chat_runs/id/requestPayload/tokenUsage');
 t.mock.method(storage,'enabled',()=>true);
 const queries=[];
 t.mock.method(storage,'getPool',()=>({query:async(sql,args)=>{queries.push({sql,args});return {rows:[{id:'id',status:'SUCCESS',timestamp:'12:00:00 22/10/2026',latencyMs:80,providerId:'p',estimatedTokens:'130',usage}]};}}));
 const [item]=await summary.history({id:'owner',role:'user'});
 assert.deepEqual(queries[0].args,[false,'account:owner','owner']);
 assert.match(queries[0].sql,/principalRef/);assert.match(queries[0].sql,/memoryDecision,accountId/);
 assert.equal(item.requestPayload.tokenUsage.totalTokens,742);assert.equal(item.estimatedTokens,130);
 assert.equal(item.question,undefined);assert.equal(item.replyText,undefined);assert.equal(item.usage,undefined);
 await summary.history({id:'admin',role:'admin'});assert.equal(queries[1].args[0],true);
});
