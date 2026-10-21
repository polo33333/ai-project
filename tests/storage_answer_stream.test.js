'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const storage=require('../src/backend/storage');
const {handleStoredRequest}=require('../src/backend/storage/http');

test('storage HTTP boundary streams transient answers and withholds verified/final until commit',async t=>{
 t.mock.method(storage,'enabled',()=>true);
 let release,failed=false;
 t.mock.method(storage,'getPool',()=>null);
 t.mock.method(console,'error',()=>{});
 t.mock.method(storage,'run',async fn=>{await fn();await new Promise(resolve=>{release=resolve;});if(failed)throw Error('Commit failed');});
 const server=http.createServer((req,res)=>handleStoredRequest(req,res,async()=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
  const send=(name,event)=>res.write('event: '+name+'\ndata: '+JSON.stringify(event)+'\n\n');
  send('answer_start',{id:'draft',verified:false});
  send('answer_delta',{id:'draft',seq:1,delta:'Public preview '});
  send('answer_reset',{id:'draft'});
  send('answer_start',{id:'verified',verified:true,animate:true});
  send('answer_delta',{id:'verified',seq:1,delta:'Verified text'});
  send('final',{reply:'Verified text'});res.end();
 }));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{release?.();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 for(const commitFails of [false,true]){
  failed=commitFails;
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/fixture');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let wire='';
  while(!wire.includes('event: answer_reset')){const chunk=await reader.read();assert.equal(chunk.done,false);wire+=decoder.decode(chunk.value);}
  assert.ok(wire.includes('Public preview'));
  assert.ok(!wire.includes('Verified text'));assert.ok(!wire.includes('event: final'));
  release();
  for(;;){const chunk=await reader.read();if(chunk.done)break;wire+=decoder.decode(chunk.value);}
  if(commitFails){assert.ok(wire.includes('event: error'));assert.ok(!wire.includes('Verified text'));assert.ok(!wire.includes('event: final'));}
  else {assert.ok(wire.includes('Verified text'));assert.ok(wire.includes('event: final'));}
 }
});
