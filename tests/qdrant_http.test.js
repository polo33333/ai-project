'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {requestJson}=require('../src/backend/services/qdrant_http');
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();return new Promise(r=>s.close(r));});return 'http://127.0.0.1:'+s.address().port;}
test('read-only vector search retries a reset once using a fresh connection',async t=>{
 let calls=0;const sockets=[];
 const base=await server(t,(req,res)=>{sockets.push(req.socket);if(++calls===1)return req.socket.destroy();res.end(JSON.stringify({status:'ok',result:[]}));});
 assert.deepEqual(await requestJson(base+'/collections/schema/points/search',{method:'POST',body:{vector:[1,0]}}),{status:'ok',result:[]});
 assert.equal(calls,2);assert.notEqual(sockets[0],sockets[1]);
});
test('persistent resets stop after two read attempts with transport context',async t=>{
 let calls=0;const base=await server(t,req=>{calls++;req.socket.destroy();});
 await assert.rejects(requestJson(base+'/collections/schema'),e=>e.code==='ECONNRESET'&&e.message.includes('GET /collections/schema'));
 assert.equal(calls,2);
});
test('upsert and delete requests are never repeated after a reset',async t=>{
 let calls=0;const base=await server(t,req=>{calls++;req.socket.destroy();});
 await assert.rejects(requestJson(base+'/collections/schema/points',{method:'PUT',body:{points:[]}}),{code:'ECONNRESET'});
 assert.equal(calls,1);
 await assert.rejects(requestJson(base+'/collections/schema/points/delete',{method:'POST',body:{filter:{}}}),{code:'ECONNRESET'});
 assert.equal(calls,2);
});
test('silent service is bounded by the overall deadline and does not retry timeout',async t=>{
 let calls=0;const base=await server(t,()=>calls++);const started=Date.now();
 await assert.rejects(requestJson(base+'/collections',{timeoutMs:80}),{code:'QDRANT_TIMEOUT'});
 assert.equal(calls,1);assert(Date.now()-started<1500);
});
test('truncated response is handled as a transient read transport failure',async t=>{
 let calls=0;const base=await server(t,(req,res)=>{if(++calls===1){res.writeHead(200,{'Content-Length':'100'});res.write('{');return setImmediate(()=>res.destroy());}res.end('{"status":"ok"}');});
 assert.deepEqual(await requestJson(base+'/collections'),{status:'ok'});assert.equal(calls,2);
});
test('HTTP and JSON failures are returned without transport retries',async t=>{
 let calls=0;const base=await server(t,(req,res)=>{calls++;if(req.url==='/http'){res.statusCode=400;return res.end('{"status":{"error":"bad request"}}');}res.end('bad json');});
 await assert.rejects(requestJson(base+'/http'),{code:'QDRANT_HTTP_ERROR',statusCode:400});
 await assert.rejects(requestJson(base+'/json'),SyntaxError);assert.equal(calls,2);
});
