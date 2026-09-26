'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const https=require('node:https');
const {EventEmitter}=require('node:events');
const {Readable}=require('node:stream');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const api=require('../src/backend/automation/api_http');
const sources=require('../src/backend/automation/data_sources');
const {AutomationRepository}=require('../src/backend/automation/repository');
const {PluginRegistry}=require('../src/backend/automation/registry');
const {AutomationRuntime}=require('../src/backend/automation/runtime');
function mockTransport(t,responses) {
  const calls=[];
  const request=(url,options,callback)=>{
    const entry={url:new URL(url),options};calls.push(entry);const req=new EventEmitter();req.destroy=failure=>req.emit('error',failure);
    const send=()=>{const current=responses.shift() || {status:200,data:{ok:true}};if(current.error){req.emit('error',current.error);return;}const response=Readable.from([current.buffer || Buffer.from(typeof current.data==='string'?current.data:JSON.stringify(current.data ?? {}))]);response.statusCode=current.status ?? 200;response.headers=current.headers || {'content-type':'application/json'};callback(response);};
    req.end=body=>{entry.body=body;process.nextTick(send);};if(options.method==='GET')process.nextTick(send);return req;
  };
  t.mock.method(https,'request',request);t.mock.method(https,'get',request);return calls;
}
test('all REST methods send resolved bodies, query, headers and encoded URL path',async t=>{
  const calls=mockTransport(t,[]);const state={input:{},steps:{previous:{id:'A/B',payload:{count:3},token:'node-token'}}};
  for(const method of api.METHODS) {
    const binding={type:'api',url:'https://example.com/items/{{steps.previous.id}}',method,query:{tag:['one','two']},headers:{'X-Trace':'{{steps.previous.id}}'},auth:{type:'bearer',token:'{{steps.previous.token}}'}};
    if(!['GET','HEAD'].includes(method)){binding.bodyFormat='json';binding.body='{{steps.previous.payload}}';}
    const result=await api.readApi(binding,state);
    assert.equal(result.response.status,200);const call=calls.at(-1);assert.equal(call.options.method,method);assert.equal(call.url.pathname,'/items/A%2FB');assert.deepEqual(call.url.searchParams.getAll('tag'),['one','two']);assert.equal(call.options.headers.authorization,'Bearer node-token');assert.equal(call.options.headers['x-trace'],'A/B');
    if(binding.body)assert.deepEqual(JSON.parse(call.body.toString()),{count:3});
  }
});
test('Basic and API key resolve server-side credentials; invalid headers and missing credentials fail',async t=>{
  const calls=mockTransport(t,[]);process.env.WORKFLOW_UNIT_PASSWORD='unit-password';process.env.WORKFLOW_UNIT_API_KEY='unit-key';t.after(()=>{delete process.env.WORKFLOW_UNIT_PASSWORD;delete process.env.WORKFLOW_UNIT_API_KEY;});
  const base={type:'api',url:'https://example.com',method:'POST',bodyFormat:'form',body:{grant:'client',code:'{{steps.previous.code}}'}};const state={input:{},steps:{previous:{code:'A&B'}}};
  await api.readApi({...base,auth:{type:'basic',username:'client',passwordEnv:'WORKFLOW_UNIT_PASSWORD'}},state);
  assert.equal(calls[0].options.headers.authorization,`Basic ${Buffer.from('client:unit-password').toString('base64')}`);assert.equal(calls[0].body.toString(),'grant=client&code=A%26B');
  await api.readApi({...base,auth:{type:'apiKey',name:'X-Api-Key',valueEnv:'WORKFLOW_UNIT_API_KEY'}},state);assert.equal(calls[1].options.headers['x-api-key'],'unit-key');
  await api.readApi({...base,auth:{type:'apiKey',name:'key',valueEnv:'WORKFLOW_UNIT_API_KEY',location:'query'}},state);assert.equal(calls[2].url.searchParams.get('key'),'unit-key');
  await assert.rejects(api.readApi({...base,headers:{Host:'evil.example'}},state),/Header/);
  await assert.rejects(api.readApi({...base,headers:{'X-Invalid':'line\r\nother'}},state),/header/);
  await assert.rejects(api.readApi({...base,auth:{type:'bearer',tokenEnv:'WORKFLOW_UNIT_ABSENT'}},state),/Credential/);
});
test('response formats cover text, JSON, no content, binary and bounded same-origin redirects',async t=>{
  const calls=mockTransport(t,[{data:'hello',headers:{'content-type':'text/plain'}},{status:204,buffer:Buffer.alloc(0)},{buffer:Buffer.from('file'),headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="report.pdf"'}},{status:302,headers:{location:'/final'},data:''},{data:{ok:true}},{status:302,headers:{location:'https://other.example.com'},data:''}]);
  const binding={type:'api',url:'https://example.com',responseFormat:'auto'};
  assert.equal((await api.readApi(binding,{input:{},steps:{}})).data,'hello');
  assert.equal((await api.readApi(binding,{input:{},steps:{}})).data,null);
  const file=await sources.executeSource(binding,{input:{},steps:{}},{permissions:['admin']});assert.equal(file.artifact.filename,'report.pdf');assert.equal(file.artifact.contentType,'application/pdf');
  const stored=path.join(require('../src/backend/utils/export_paths').getExportsDirectory(),'automation',file.artifact.storageName);t.after(()=>fs.unlinkSync(stored));assert.equal(fs.readFileSync(stored).toString(),'file');
  assert.equal((await api.readApi({...binding,maxRedirects:1},{input:{},steps:{}})).data.ok,true);assert.equal(calls.at(-1).url.pathname,'/final');
  await assert.rejects(api.readApi({...binding,maxRedirects:1},{input:{},steps:{}}),/origin/);
});
test('managed files can be sent as multipart or binary body',async t=>{
  const library=require('../src/backend/services/library_service');const root=path.join(require('../src/backend/utils/storage_helper').getDataDirectory(),'library_files'),file=path.join(root,'api-upload.txt');fs.writeFileSync(file,'upload-content');const document={id:'api-upload',storagePath:file,filename:'example.txt'};library.documents.push(document);t.after(()=>{fs.unlinkSync(file);library.documents=library.documents.filter(item=>item!==document);});
  const calls=mockTransport(t,[]);const state={input:{},steps:{previous:{documentId:document.id}}};
  await api.readApi({type:'api',url:'https://example.com',method:'POST',bodyFormat:'multipart',body:{comment:'hello',file:{documentId:'{{steps.previous.documentId}}'}}},state);
  const body=calls[0].body.toString();assert.match(body,/multipart|Content-Disposition/);assert.match(body,/filename="example.txt"/);assert.match(body,/upload-content/);assert.match(calls[0].options.headers['content-type'],/^multipart\/form-data; boundary=/);
  await api.readApi({type:'api',url:'https://example.com',method:'PUT',bodyFormat:'binary',body:'{{steps.previous.documentId}}'},state);assert.equal(calls[1].body.toString(),'upload-content');
});
test('private HTTP requires an exact configured origin; input cannot replace the host',()=>{
  const previous=process.env.WORKFLOW_API_ALLOWED_ORIGINS;process.env.WORKFLOW_API_ALLOWED_ORIGINS='http://127.0.0.1:8080';
  try{assert.equal(api.apiUrl('http://127.0.0.1:8080/items').protocol,'http:');assert.throws(()=>api.apiUrl('http://127.0.0.1:8081/items'));assert.throws(()=>api.apiUrl('https://{{input.host}}/items'));}finally{if(previous===undefined)delete process.env.WORKFLOW_API_ALLOWED_ORIGINS;else process.env.WORKFLOW_API_ALLOWED_ORIGINS=previous;}
});
test('write API is not retried after failure or recovered automatically after interruption',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'api-write-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const repository=new AutomationRepository({directory}),registry=new PluginRegistry(repository),admin={accountId:'admin',permissions:['admin']};
  const definition=structuredClone(require('../src/backend/automation/pilot.json'));definition.manifest.id='api_write';definition.templates=[definition.templates[0]];const template=definition.templates[0];template.allowedCapabilities=['data.read'];template.bindings={write:{type:'api',url:'https://example.com',method:'POST',bodyFormat:'json',body:{code:'{{input.code}}'}}};template.workflow.steps=[{id:'send',type:'source',config:{bindingRef:'write'},retry:{maxAttempts:3}}];template.output.mapping={code:'{{steps.send.data.code}}',source:'api'};template.fixtures=[{input:{code:'A001'},stepResults:{send:{data:{code:'A001'}}},expected:{code:'A001',source:'api'}}];
  let record=await registry.import(definition,admin);assert.equal((await registry.test(record.id,admin)).passed,true);record=await repository.get('catalog',record.id);await registry.publish(record.id,admin,record.revision);
  let calls=0;const runtime=new AutomationRuntime(repository,registry,{enabled:()=>true,authorizeContext:async()=>admin,executeSource:async()=>{calls++;throw Object.assign(new Error('network interrupted'),{apiRequestStarted:true});}});
  let run=await runtime.create('api_write/lookup',{code:'A001'},admin,{conversationId:'write-fail'});await runtime.process(run.id);run=await runtime.owned(run.id,admin);assert.equal(run.status,'NEEDS_REVIEW');assert.equal(calls,1);
  let second=await runtime.create('api_write/lookup',{code:'A001'},admin,{conversationId:'write-recovery'});second=await runtime.owned(second.id,admin);second.status='RUNNING';second.lease={expiresAt:0};await repository.put('runs',second,second.revision);await runtime.process(second.id);assert.equal((await runtime.owned(second.id,admin)).status,'NEEDS_REVIEW');assert.equal(calls,1);
});
