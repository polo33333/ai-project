'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const sources = require('../src/backend/automation/data_sources');
const { validatePackage } = require('../src/backend/automation/contract');
const { AutomationRepository } = require('../src/backend/automation/repository');
const { PluginRegistry } = require('../src/backend/automation/registry');
const { AutomationRuntime } = require('../src/backend/automation/runtime');
const admin = { accountId:'source-admin',permissions:['admin'] };
function bundle() {
  const result=structuredClone(require('../src/backend/automation/pilot.json'));
  result.manifest.id='source_pipeline'; result.templates=[result.templates[0]];
  const template=result.templates[0]; template.allowedCapabilities=['data.transform','data.read'];
  template.bindings={remote:{type:'api',url:'https://example.com/data',query:{code:'{{steps.prepare.code}}'},dataPath:'records'},inherited:{type:'previous',reference:'{{steps.remote.rows}}'}};
  template.workflow.steps=[{id:'prepare',type:'transform',config:{mapping:{code:'{{input.code}}'}}},{id:'remote',type:'source',config:{bindingRef:'remote'}},{id:'inherit',type:'source',config:{bindingRef:'inherited'}}];
  template.output.mapping={code:'{{steps.inherit.rows.0.code}}',source:'{{steps.inherit.rows.0.source}}'};
  template.fixtures=[{input:{code:'A001'},stepResults:{remote:{rows:[{code:'A001',source:'api'}]}},expected:{code:'A001',source:'api'}}];
  return result;
}
test('API and previous-node sources validate, publish, persist and execute with references',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sources-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const repository=new AutomationRepository({directory}),registry=new PluginRegistry(repository);
  let requests=0;
  t.mock.method(https,'get',(url,options,callback)=>{
    requests++;assert.equal(url.searchParams.get('code'),'A001');assert.equal(options.headers.accept,'application/json');
    const request=new EventEmitter();request.destroy=failure=>request.emit('error',failure);
    process.nextTick(()=>{const response=Readable.from([JSON.stringify({records:[{code:'A001',source:'api'}]})]);response.statusCode=200;callback(response);});return request;
  });
  let record=await registry.import(bundle(),admin);
  assert.equal((await registry.test(record.id,admin)).passed,true);assert.equal(requests,0,'fixtures must not call APIs');
  record=await repository.get('catalog',record.id);await registry.publish(record.id,admin,record.revision);
  const runtime=new AutomationRuntime(repository,registry,{enabled:()=>true,authorizeContext:async()=>admin});
  const run=await runtime.create('source_pipeline/lookup',{code:'A001'},admin,{conversationId:'chain'});
  await runtime.process(run.id);const final=await runtime.owned(run.id,admin);
  assert.equal(final.status,'SUCCEEDED',final.error);assert.deepEqual(final.result,{code:'A001',source:'api'});assert.equal(requests,1);
  assert.deepEqual(final.outputs.inherit.rows,final.outputs.remote.rows);
});
test('references cannot target the current or a later node; SQL remains static',()=>{
  const definition=bundle();definition.templates[0].bindings.remote.query.code='{{steps.inherit.rows}}';
  assert.throws(()=>validatePackage(definition),/chưa chạy/);
  definition.templates[0].bindings.remote.query.code='{{steps.remote.rows}}';
  assert.throws(()=>validatePackage(definition),/chưa chạy/);
});
test('API only reads HTTPS JSON and blocks private endpoints and excessive data',async()=>{
  for(const address of ['127.0.0.1','10.0.0.1','192.168.1.2','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(Boolean(sources.publicAddress(address)),false,address);
  assert.equal(sources.publicAddress('8.8.8.8'),true);
  for(const url of ['http://example.com','https://127.0.0.1','https://[::1]','https://user:password@example.com'])assert.throws(()=>sources.apiUrl(url));
  assert.throws(()=>sources.validateSource({type:'api',url:'https://example.com',method:'TRACE'}),/Phương thức/);
  await assert.rejects(sources.executeSource({type:'api',url:'https://example.com'},{input:{},steps:{}},{permissions:[]}),{statusCode:403});
  assert.throws(()=>sources.normalizeData(Array.from({length:1001},()=>({a:1})),'api'),/1.000/);
  assert.throws(()=>sources.normalizeData('x'.repeat(2*1024*1024),'api'),/2 MB/);
});
test('file source reads a managed CSV; revoked or unknown files fail',async t=>{
  const library=require('../src/backend/services/library_service');
  const root=path.join(require('../src/backend/utils/storage_helper').getDataDirectory(),'library_files');
  const file=path.join(root,'source-test.csv');fs.writeFileSync(file,'code,name\nA001,Example\n');
  const document={id:'source-test',type:'CSV',storagePath:file};library.documents.push(document);
  t.after(()=>{library.documents=library.documents.filter(item=>item!==document);fs.unlinkSync(file);});
  const output=await sources.executeSource({type:'file',documentId:'{{steps.file.id}}',format:'auto'},{input:{},steps:{file:{id:document.id}}},{permissions:['knowledge:read']});
  assert.deepEqual(output.rows,[{code:'A001',name:'Example'}]);
  document.isActive=false;await assert.rejects(sources.executeSource({type:'file',documentId:document.id},{input:{},steps:{}},{permissions:['admin']}),/Thư viện/);
});
test('API rejects redirects, malformed JSON and DNS resolving to private addresses',async t=>{
  const dns=require('node:dns');
  let status=302,body='{}',checkDns=false;
  t.mock.method(dns,'lookup',(host,options,callback)=>callback(null,[{address:'127.0.0.1',family:4}]));
  t.mock.method(https,'get',(url,options,callback)=>{
    const request=new EventEmitter();request.destroy=failure=>request.emit('error',failure);
    process.nextTick(()=>{
      if(checkDns) { options.lookup(url.hostname,{all:true},failure=>request.emit('error',failure)); return; }
      const response=Readable.from([Buffer.from(body)]);response.statusCode=status;callback(response);
    });return request;
  });
  const execute=()=>sources.executeSource({type:'api',url:'https://example.com'},{input:{},steps:{}},{permissions:['knowledge:read']});
  await assert.rejects(execute(),/HTTP 302/);
  status=200;body='<html>error</html>';await assert.rejects(execute(),/JSON/);
  checkDns=true;await assert.rejects(execute(),/nội bộ/);
});
test('SQL binds a typed scalar from previous-node results and rejects the wrong type',async t=>{
  const connector=require('../src/backend/services/sql_connector');
  const originalSources=connector.dbSources,originalSchemas=connector.schemas;
  t.after(()=>{connector.dbSources=originalSources;connector.schemas=originalSchemas;});
  connector.dbSources=[{id:'source-test-db'}];connector.schemas=[{dbSourceId:'source-test-db',schemaName:'dbo',tableName:'Records'}];
  let parameters;t.mock.method(connector,'executeSqlQuery',async(sql,source,signal,values)=>{parameters=values;return [{ID:7}];});
  const binding={sql:'SELECT TOP 10 ID FROM dbo.Records WHERE ID=@id',dbSourceId:'source-test-db',tables:['dbo.Records'],parameters:{id:{value:'{{steps.previous.rows.0.ID}}',type:'integer'}}};
  const state={input:{},steps:{previous:{rows:[{ID:7}]}}};
  const output=await sources.executeSource(binding,state,{permissions:['sql:read']});assert.equal(output.rowCount,1);assert.deepEqual(parameters,[{name:'id',type:'integer',value:7}]);
  state.steps.previous.rows[0].ID='bad';await assert.rejects(sources.executeSource(binding,state,{permissions:['sql:read']}),/đúng kiểu/);
});
