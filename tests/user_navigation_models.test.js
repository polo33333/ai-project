'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),vm=require('node:vm'),fs=require('node:fs');
test('User chat selector reads a minimal model catalog while admin provider APIs remain forbidden',async t=>{
  process.env.BOOTSTRAP_ADMIN_PASSWORD='isolated-test-password';
  const auth=require('../src/backend/services/auth_service'),manager=require('../src/backend/services/ai_provider_manager');
  let grants=['chat.use'];
  t.mock.method(auth,'getAccountBySession',()=>({id:'test-user',role:'user',permissions:grants}));
  t.mock.method(manager,'getProviders',()=>[{id:'model-1',name:'Model',type:'Test',model:'test-model',isActive:true,apiKey:'private-secret',baseUrl:'private-url',tokenCost:42}]);
  const server=http.createServer((req,res)=>require('../src/backend/routes/router').handleRequest(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/chat/providers');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{providers:[{id:'model-1',name:'Model',type:'Test',model:'test-model',isActive:true}]});
  for(const path of ['/api/ai-providers','/api/providers'])assert.equal((await fetch(base+path)).status,403);
  grants=['dashboard.read'];assert.equal((await fetch(base+'/api/chat/providers')).status,200);
  assert.equal((await fetch(base+'/api/ai-providers')).status,403);
  grants=[];assert.equal((await fetch(base+'/api/chat/providers')).status,403);
});
test('sidebar hides empty sections and restores them when a permitted item appears',()=>{
  const source=fs.readFileSync('src/frontend/js/app.js','utf8');
  const sections=[{children:[{hidden:true,style:{}},{hidden:true,style:{}}]},{children:[{hidden:false,style:{}}]},{children:[{hidden:false,style:{display:'none'}}]}];
  sections.forEach(s=>s.querySelectorAll=()=>s.children);
  const context={window:{},document:{querySelectorAll:()=>sections}};vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('window.refreshSidebarGroups ='),source.indexOf('function selectAccountTab')),context);
  context.window.refreshSidebarGroups();assert.deepEqual(sections.map(s=>s.hidden),[true,false,true]);
  sections[0].children[0].hidden=false;context.window.refreshSidebarGroups();assert.equal(sections[0].hidden,false);
});
test('User dashboard loads the safe model catalog and skips sources for functions not granted',async()=>{
  const source=fs.readFileSync('src/frontend/js/modules/analytics.js','utf8'),calls=[];
  const context={window:{currentAccountRole:'user',currentAccountPermissions:['dashboard.read']},fetch:async path=>{
    calls.push(path);return {ok:true,json:async()=>path==='/api/chat/providers'?{providers:[{id:'model',name:'Configured model',isActive:true}]}:{}};
  }};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function fetchAnalyticsSourceData'),source.indexOf('function destroyChart')),context);
  const data=await context.fetchAnalyticsSourceData();
  assert.deepEqual(calls,['/api/chat/providers','/api/qdrant/status']);
  assert.equal(data.providers[0].name,'Configured model');assert.equal(data.providers[0].isActive,true);
});
