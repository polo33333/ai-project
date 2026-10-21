'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {requestStores}=require('../src/backend/storage/request_stores');
test('memory, backups and embed identity read only relevant stores',()=>{
 for(const path of ['/api/memory','/api/memory/events','/api/backups','/api/backups/status','/api/accounts/embed-identity']) {
  const files=requestStores({method:'GET',url:path});assert.ok(files);
  for(const unrelated of ['chat_history.json','chat_feedback.json','dictionary.json','workflow_runs.json'])assert.ok(!files.includes(unrelated),path+': '+unrelated);
 }
 const memory=requestStores({method:'GET',url:'/api/memory/events'});
 assert.ok(memory.includes('episodic_memory.json'));assert.ok(memory.includes('db_sources.json'));assert.ok(memory.includes('library.json'));
 assert.equal(requestStores({method:'POST',url:'/api/memory'}),undefined);
});
test('audit lists and selected details skip full-store hydration and training loads reviewed audits directly',()=>{
 for(const path of ['/api/chat-history?list=1','/api/chat-history?id=a','/api/chat-feedback?list=1'])assert.deepEqual(requestStores({method:'GET',url:path}),['accounts.json','sessions.json','account_roles.json']);
 const training=requestStores({method:'GET',url:'/api/training-report'});
 assert.ok(training.includes('chat_feedback.json'));assert.ok(training.includes('training_resolutions.json'));assert.ok(!training.includes('chat_history.json'));
});
