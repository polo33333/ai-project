'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/frontend/js/modules/page_chat.js'),'utf8');
function fixture(fetch) {
  const writes=[];
  const context=vm.createContext({window:{chatSessions:[],currentChatSessionId:'s'},fetch,
    CHAT_ACTIVE_SESSION_KEY:'active', localStorage:{setItem:(...args)=>writes.push(args)},
    showToast(){},console:{error(){}},document:{getElementById(){return null;},createElement(){return {};}}});
  vm.runInContext(source.slice(source.indexOf('let chatHistoryLoaded'),source.indexOf('function clearBackendConversationMemory')),context);
  vm.runInContext('chatHistoryLoaded=true',context);
  return {context,writes,run:code=>vm.runInContext(code,context)};
}
test('page chat saves changed sessions through API and stores only active ID locally',async()=>{
  const requests=[];
  const f=fixture(async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({versions:{s:requests.length}})};});
  f.run("window.chatSessions=[{id:'s',title:'First',messages:[],history:[]}]");
  await f.run('saveChatSessions()');await f.run('saveChatSessions()');
  assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/page-chat/sessions');
  assert.equal(requests[0].body.changes[0].version,0);
  f.run("window.chatSessions[0].title='Renamed'");await f.run('saveChatSessions()');
  assert.equal(requests[1].body.changes[0].version,1);
  assert.ok(f.writes.every(([key])=>key==='active'));
});
test('page chat sends versioned deletes and retains unsaved content after a failed write',async()=>{
  let fail=false;const requests=[];
  const f=fixture(async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:!fail,status:503,json:async()=>({versions:{s:1}})};});
  f.run("window.chatSessions=[{id:'s',title:'First',messages:[],history:[]}]");await f.run('saveChatSessions()');
  f.run('window.chatSessions=[]');await f.run('saveChatSessions()');
  assert.deepEqual(requests[1].deleted,[{id:'s',version:1}]);
  fail=true;f.run("window.chatSessions=[{id:'unsaved',title:'Keep',messages:[],history:[]}]");
  assert.equal(await f.run('saveChatSessions()'),false);
  assert.equal(f.run('window.chatSessions[0].title'),'Keep');assert.equal(f.run('chatHistoryFailed'),true);
});
