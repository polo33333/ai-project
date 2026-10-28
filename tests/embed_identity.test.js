'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto'), http=require('node:http');
const identity=require('../src/backend/services/embed_identity');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const setup={enabled:true,required:true,serverUrl:'https://website.test',issuer:'https://website.test',audience:'widget',publicKey:publicKey.export({type:'spki',format:'pem'})};
function token(overrides={},key=privateKey,header={alg:'RS256',typ:'JWT'}) {
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const input=encode(header)+'.'+encode({iss:setup.issuer,aud:setup.audience,sub:'user-1',name:'Test User',exp:Math.floor(Date.now()/1000)+300,...overrides});
  return input+'.'+crypto.sign('RSA-SHA256',Buffer.from(input),key).toString('base64url');
}
test('RS256 validates signature, issuer, audience, expiry and guest policy',()=>{
  const config={id:'widget-1',identity:identity.normalize(setup)};
  assert.equal(identity.verify(config,token()).subject,'user-1');
  for(const claims of [{iss:'other'},{aud:'other'},{exp:0},{exp:Math.floor(Date.now()/1000)+7200},{nbf:Math.floor(Date.now()/1000)+300},{sub:''}]) assert.throws(()=>identity.verify(config,token(claims)),{statusCode:401});
  assert.throws(()=>identity.verify(config,token({},privateKey,{alg:'none'})),{statusCode:401});
  const other=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  assert.throws(()=>identity.verify(config,token({},other.privateKey)),{statusCode:401});
  assert.throws(()=>identity.verify(config,null),{statusCode:401});
  assert.equal(identity.verify({...config,identity:{...config.identity,required:false}},null),null);
  assert.throws(()=>identity.normalize({...setup,publicKey:privateKey.export({type:'pkcs8',format:'pem'})}));
});
test('workflow credentials and memory remain isolated across visitors and full session IDs',t=>{
  const embed=require('../src/backend/services/embed_chat_service'); t.mock.method(embed,'persist',()=>{});
  const config={id:'widget',workflowSecret:'test'}, a=identity.verify({id:'widget',identity:setup},token()), b=identity.verify({id:'widget',identity:setup},token({sub:'user-2'}));
  const issued=embed.workflowSession(config,'session',null,a);
  assert.equal(embed.workflowSession(config,'session',issued.token,a).accountId,issued.accountId);
  assert.throws(()=>embed.workflowSession(config,'session',issued.token,b),{statusCode:403});
  assert.throws(()=>embed.workflowSession(config,'session',issued.token),{statusCode:403});
  assert.notEqual(embed.conversationId(config,'a'.repeat(99)+'1',a),embed.conversationId(config,'a'.repeat(99)+'2',a));
  assert.notEqual(embed.conversationId(config,'session',a),embed.conversationId(config,'session',b));
});
test('admin config and public heartbeat enforce authentication without running AI',async t=>{
  process.env.BOOTSTRAP_ADMIN_PASSWORD='embed-identity-test-password';
  const auth=require('../src/backend/services/auth_service'),embed=require('../src/backend/services/embed_chat_service');
  const old={accounts:auth.accounts,sessions:auth.sessions,configs:embed.configs,active:embed.activeSessions};
  t.after(()=>{auth.accounts=old.accounts;auth.sessions=old.sessions;embed.configs=old.configs;embed.activeSessions=old.active;});
  auth.accounts=[{id:'owner',username:'owner',displayName:'Owner',role:'admin',isActive:true,passwordHash:auth.hashPassword('owner-password')},{id:'member',username:'member',role:'user',isActive:true,passwordHash:auth.hashPassword('member-password')}];auth.sessions={};embed.configs=[];embed.activeSessions=new Map();
  t.mock.method(auth,'persistSessions',()=>{});t.mock.method(embed,'persist',()=>{});
  const config=embed.createConfig({name:'Identity widget',allowedOrigins:['https://website.test'],rateLimit:100});
  const router=require('../src/backend/routes/router');const server=http.createServer((req,res)=>router.handleRequest(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  const admin=auth.login('owner','owner-password'),member=auth.login('member','member-password');
  const call=async(path,method='GET',body,cookie)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:'kh_session='+cookie}:{Origin:'https://website.test'})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};
  };
  assert.equal((await call('/api/accounts/embed-identity','GET',null,member.token)).status,403);
  assert.equal((await call('/api/accounts/embed-identity','PUT',{embedId:config.id,identity:setup},admin.token)).status,200);
  const heartbeat={embedId:config.id,sessionId:'visitor-session',presence:true};
  assert.equal((await call('/api/embed/chat','POST',heartbeat)).status,401);
  assert.equal((await call('/api/embed/chat','POST',{...heartbeat,identityToken:token()})).status,200);
  let result=await call('/api/accounts/embed-identity','GET',null,admin.token);
  assert.equal(result.data.sessions[0].identity.name,'Test User');assert.equal(result.data.sessions[0].online,true);
  embed.activeSessions.values().next().value.lastSeen-=91000;
  result=await call('/api/accounts/embed-identity','GET',null,admin.token);assert.equal(result.data.sessions[0].online,false);
  t.mock.method(require('../src/backend/intelligent_core/core'),'chat',async()=>({success:true,replyText:'Hello',toolCalls:[],trace:{completionStatus:'PARTIAL'}}));
  const audit=t.mock.method(require('../src/backend/services/logger_service'),'addChatAudit',()=>({id:'identity-audit'}));
  const identityToken=token();
  result=await call('/api/embed/chat','POST',{embedId:config.id,sessionId:'visitor-session',question:'Hello',identityToken});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(audit.mock.calls[0].arguments[7].visitorIdentity.subject,'user-1');
  assert.ok(!JSON.stringify(audit.mock.calls[0].arguments).includes(identityToken));
  // A failed question is kept in the chat history with the visitor and the reason.
  require('../src/backend/intelligent_core/core').chat.mock.mockImplementationOnce(async()=>({success:false,error:'AI provider không phản hồi.',errorCode:'PROVIDER_DOWN',trace:{}}));
  result=await call('/api/embed/chat','POST',{embedId:config.id,sessionId:'visitor-session',question:'ds nv',identityToken});
  assert.equal(result.status,500);
  const failed=audit.mock.calls[1].arguments;
  assert.deepEqual([failed[0],failed[1],failed[5],failed[6]],['ds nv',null,'ERROR','AI provider không phản hồi.']);
  assert.equal(failed[7].embedId,config.id);assert.equal(failed[7].visitorIdentity.subject,'user-1');assert.equal(failed[7].errorCode,'PROVIDER_DOWN');
  assert.ok(!JSON.stringify(failed).includes(identityToken));
  const coreCalls=require('../src/backend/intelligent_core/core').chat.mock.callCount();
  const uploads=t.mock.method(require('../src/backend/services/chat_attachment_service'),'submit',async(owner,body)=>({status:'success',reply:'Tính năng xử lý tệp đang phát triển.',completionStatus:'SUCCESS'}));
  result=await call('/api/chat/attachments','POST',{files:[]},admin.token);
  assert.equal(result.status,200);assert.equal(uploads.mock.calls[0].arguments[0],'owner');
  result=await call('/api/chat/attachments','POST',{files:[]});assert.equal(result.status,403);
  result=await call('/api/embed/chat','POST',{embedId:config.id,sessionId:'visitor-session',identityToken,files:[]});
  assert.equal(result.status,200);assert.equal(result.data.reply,'Tính năng xử lý tệp đang phát triển.');
  const verifiedOwner=JSON.parse(uploads.mock.calls[1].arguments[0]);
  assert.equal(verifiedOwner[1],identity.verify(config,identityToken).id);
  const count=uploads.mock.callCount();
  result=await call('/api/embed/chat','POST',{embedId:config.id,sessionId:'visitor-session',files:[]});
  assert.equal(result.status,401);assert.equal(uploads.mock.callCount(),count);
  assert.equal(require('../src/backend/intelligent_core/core').chat.mock.callCount(),coreCalls);
  const read=t.mock.method(require('../src/backend/services/chat_attachment_service'),'read',async(owner,batchId,fileId)=>({name:'a.pdf',type:'application/pdf',size:3,bytes:Buffer.from('PDF')}));
  let download=await fetch(base+'/api/chat/attachments/file?batchId=batch&fileId=file',{headers:{Cookie:'kh_session='+admin.token}});
  assert.equal(download.status,200);assert.equal(await download.text(),'PDF');
  assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.equal(read.mock.calls[0].arguments[0],'owner');
  result=await call('/api/embed/chat','POST',{embedId:config.id,sessionId:'visitor-session',identityToken,batchId:'batch',fileId:'file',attachmentAction:'file'});
  assert.equal(result.status,200);assert.equal(result.data.base64,Buffer.from('PDF').toString('base64'));
  assert.equal(JSON.parse(read.mock.calls[1].arguments[0])[1],verifiedOwner[1]);
});

test('widget resets on account change but preserves token refresh, including without browser storage',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const source=fs.readFileSync('src/frontend/embed-client/knowledgehub-chat.js','utf8');
  const start=source.indexOf('  let lastIdentityKey;'),end=source.indexOf('  const history = [];',start);
  let current=null,resets=0;
  const context=vm.createContext({window:{KnowledgeHubIdentity:{getToken:async()=>current}},embedId:'widget',workflowStorageKey:'key',workflowToken:'',atob,sessionStorage:{getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}},resetConversation(){resets++;}});
  vm.runInContext(source.slice(start,end),context);
  await context.identityToken();current=token();await context.identityToken();assert.equal(resets,1);
  current=token({exp:Math.floor(Date.now()/1000)+200});await context.identityToken();assert.equal(resets,1);
  current=token({sub:'user-2'});await context.identityToken();assert.equal(resets,2);
  current=null;await context.identityToken();assert.equal(resets,3);
});

test('website sample issues signed identity only from an authenticated server session',async t=>{
  const {createChatIdentityHandler}=require('../examples/embed-identity-server');
  const handler=createChatIdentityHandler({privateKey,issuer:setup.issuer,widgets:{widget:setup.audience},getAuthenticatedUser:async req=>req.headers.cookie==='session=valid'?{id:'server-user',displayName:'Server User'}:null});
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  let response=await fetch(base+'/?embedId=widget&sub=forged');assert.equal((await response.json()).token,null);
  response=await fetch(base+'/?embedId=widget&sub=forged',{headers:{Cookie:'session=valid'}});
  assert.equal(identity.verify({id:'widget',identity:setup},(await response.json()).token).subject,'server-user');
  response=await fetch(base+'/?embedId=untrusted',{headers:{Cookie:'session=valid'}});assert.equal(response.status,403);
});
