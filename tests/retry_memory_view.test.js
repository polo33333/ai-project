const test=require('node:test'),assert=require('node:assert/strict');
const {MemoryService}=require('../src/backend/memory/memory_service');
test('retry history bounds repeated identical answers by their actual occurrence',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('src/backend/services/page_chat_history_service.js','utf8');
  const context=vm.createContext({fail(message){throw Error(message)}});
  vm.runInContext(source.slice(source.indexOf('function retryTurn('),source.indexOf('async function assertCanChat(')),context);
  context.session={messages:[{role:'user',content:'Q'},{role:'assistant',content:'A'},{role:'user',content:'Q'},{role:'assistant',content:'A'}],history:[{role:'user',content:'Q'},{role:'assistant',content:'A'},{role:'user',content:'Q'},{role:'assistant',content:'A'}]};
  assert.equal(vm.runInContext('retryTurn(session,1).contextEnd',context),0);
  assert.equal(vm.runInContext('retryTurn(session,3).contextEnd',context),2);
  context.session.messages[3].content='failed';context.session.history=context.session.history.slice(0,2);
  assert.equal(vm.runInContext('retryTurn(session,3).contextEnd',context),2);
});
test('retry restores the pre-question memory, excluding failed and future results',()=>{
  const service=new MemoryService({store:{sessions:{}},save(){}});
  const args={sessionId:'s',accountId:'admin',question:'add field',history:[{role:'user',content:'list'},{role:'assistant',content:'old list'}]};
  const state=service.getSession('s',true,'admin');state.references.lastDataset={table:'Employees'};
  service.requestView(args);
  state.references.lastDataset={table:'Customers'};state.pendingTurn={question:'failed'};
  const retry=service.requestView({...args,retry:true,latest:true});
  assert.equal(retry.retryContextSource,'checkpoint');
  assert.equal(retry.getSession('s',false,'admin').references.lastDataset.table,'Employees');
  assert.equal(retry.getSession('s',false,'admin').pendingTurn,null);
  assert.equal(service.getSession('s',false,'admin').references.lastDataset.table,'Customers');
  retry.getSession('s',false,'admin').references.lastDataset={table:'FreshEmployees'};
  retry.commitRetry();
  assert.equal(service.getSession('s',false,'admin').references.lastDataset.table,'FreshEmployees');
});
test('legacy retries use only bounded history; older retries cannot overwrite current memory',()=>{
  const service=new MemoryService({store:{sessions:{}},save(){}});
  service.getSession('s',true,'admin').references.lastEntity={table:'Future'};
  const history=[{role:'user',content:'before'},{role:'assistant',content:'verified answer'}];
  const retry=service.requestView({sessionId:'s',accountId:'admin',question:'retry',history,retry:true,latest:false});
  const state=retry.getSession('s',false,'admin');
  assert.equal(state.references.lastEntity,null);assert.equal(state.pendingTurn,null);assert.equal(state.messages.length,2);
  state.references.lastEntity={table:'Replacement'};retry.commitRetry();
  assert.equal(service.getSession('s',false,'admin').references.lastEntity.table,'Future');
});
