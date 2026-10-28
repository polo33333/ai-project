'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), http=require('node:http');

test('embed visitors rate only answers of their widget and conversation', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD ||= 'embed-feedback-test-password';
  const embed=require('../src/backend/services/embed_chat_service');
  const old={configs:embed.configs,active:embed.activeSessions};
  t.after(()=>{embed.configs=old.configs;embed.activeSessions=old.active;});
  embed.configs=[];embed.activeSessions=new Map();
  t.mock.method(embed,'persist',()=>{});
  const config=embed.createConfig({name:'Feedback widget',allowedOrigins:['https://website.test'],rateLimit:100});
  const runs={
    mine:{id:'mine',modelName:'gemini',requestPayload:{embedId:config.id,sessionId:'visitor-1',providerId:'p1'}},
    otherSession:{id:'otherSession',requestPayload:{embedId:config.id,sessionId:'visitor-2'}},
    otherWidget:{id:'otherWidget',requestPayload:{embedId:'another-widget',sessionId:'visitor-1'}}
  };
  t.mock.method(require('../src/backend/services/audit_reader'),'records',async ids=>ids.map(id=>runs[id]).filter(Boolean));
  const saved=t.mock.method(require('../src/backend/services/logger_service'),'addChatFeedback',(auditId,rating)=>({auditId,rating}));
  const router=require('../src/backend/routes/router');const server=http.createServer((req,res)=>router.handleRequest(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const rate=async(auditId,rating='like',sessionId='visitor-1')=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/embed/chat`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://website.test'},
      body:JSON.stringify({embedId:config.id,sessionId,feedback:{auditId,rating}})});
    return {status:response.status,data:await response.json()};
  };
  const result=await rate('mine','dislike');
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.rating,'dislike');
  assert.deepEqual(saved.mock.calls[0].arguments.slice(0,2),['mine','dislike']);
  assert.deepEqual(saved.mock.calls[0].arguments[2],{providerId:'p1',model:'gemini'});
  for (const id of ['otherSession','otherWidget','missing']) assert.equal((await rate(id)).status,404,id);
  assert.equal((await rate('mine','like','')).status,404,'a visitor without a conversation rates nothing');
  assert.equal((await rate('mine','love')).status,400);
  assert.equal(saved.mock.callCount(),1);
});
