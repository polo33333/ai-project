'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const usage=require('../src/backend/services/ai_usage_service');
const governance=require('../src/backend/governance/context');
const adapters=require('../src/backend/intelligent_core/adapters');

const provider={id:'local-1',name:'Ollama',model:'qwen',baseUrl:'http://localhost:11434',type:'Ollama (Local)'};
function isolated(t) {
 const original=usage.service, directory=fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-'));
 usage.service=new usage.AiUsageService({directory});
 t.after(()=>{usage.service=original;fs.rmSync(directory,{recursive:true,force:true});});
 return usage.service;
}
const asAccount=(id,operation)=>governance.run(()=>{governance.setPrincipal({subject:`account:${id}`,role:'user'});return operation();});

test('model calls are counted per account and per provider in day and month buckets',async t=>{
 const service=isolated(t), originalFetch=global.fetch;
 global.fetch=async()=>new Response(JSON.stringify({message:{content:'ok'},prompt_eval_count:30,eval_count:20,done:true}),{status:200,headers:{'Content-Type':'application/json'}});
 t.after(()=>{global.fetch=originalFetch;});
 await asAccount('u1',()=>adapters.dispatchToProvider(provider,[{role:'user',content:'xin chào'}],[]));
 const counted=await service.usage();
 assert.deepEqual(counted['account|u1'],{day:50,week:50,month:50,dayRequests:1,weekRequests:1,monthRequests:1});
 assert.deepEqual(counted['provider|local-1'],{day:50,week:50,month:50,dayRequests:1,weekRequests:1,monthRequests:1});
});

test('an exhausted account quota or a locked model blocks the next call with a clear message',async t=>{
 const service=isolated(t);
 await service.record({accountId:'u1',providerId:'local-1',tokens:120});
 await service.setLimit({scope:'account',targetId:'u1',period:'day',tokenLimit:100},'admin');
 await assert.rejects(service.check({accountId:'u1',provider}),error=>error.statusCode===429&&error.code==='AI_ACCOUNT_QUOTA'&&/hôm nay/.test(error.message));
 await service.check({accountId:'u2',provider});
 await service.setLimit({scope:'provider',targetId:'local-1',period:'month',tokenLimit:null,locked:true},'admin');
 await assert.rejects(service.check({accountId:'u2',provider}),error=>error.code==='AI_PROVIDER_LOCKED');
 await service.setLimit({scope:'account',targetId:'u2',period:'month',tokenLimit:null,locked:true},'admin');
 await assert.rejects(service.check({accountId:'u2',provider}),error=>error.code==='AI_ACCOUNT_LOCKED');
});

test('limits reject negative or fractional token values and unknown scopes',async t=>{
 const service=isolated(t);
 await assert.rejects(service.setLimit({scope:'account',targetId:'u1',tokenLimit:-1}),/số nguyên không âm/);
 await assert.rejects(service.setLimit({scope:'account',targetId:'u1',tokenLimit:1.5}),/số nguyên không âm/);
 await assert.rejects(service.setLimit({scope:'team',targetId:'x'}),/không hợp lệ/);
 const saved=await service.setLimit({scope:'provider',targetId:'local-1',tokenLimit:''},'admin');
 assert.equal(saved.tokenLimit,null); assert.equal(saved.period,'month');
});

test('a question admitted within the quota finishes all its model calls; the next question is blocked',async t=>{
 const service=isolated(t);
 await service.setLimit({scope:'account',targetId:'u1',period:'day',tokenLimit:100},'admin');
 const question=new Set();
 await service.check({accountId:'u1',provider,admitted:question});
 await service.record({accountId:'u1',providerId:provider.id,tokens:150});
 await service.check({accountId:'u1',provider,admitted:question});
 await assert.rejects(service.check({accountId:'u1',provider,admitted:new Set()}),error=>error.code==='AI_ACCOUNT_QUOTA');
});

test('a user sees their own limit, use and the next reset in Vietnam time',async t=>{
 const service=isolated(t);
 assert.deepEqual(await service.accountStatus('u1'),{limited:false,locked:false});
 await service.setLimit({scope:'account',targetId:'u1',period:'day',tokenLimit:8000},'admin');
 await service.record({accountId:'u1',providerId:provider.id,tokens:6900});
 const status=await service.accountStatus('u1');
 assert.equal(status.used,6900); assert.equal(status.limited,true); assert.ok(Math.abs(status.ratio-0.8625)<1e-9);
 assert.equal(usage.resetTime('day',new Date('2026-10-25T18:30:00Z')),'2026-10-26T17:00:00.000Z');
 assert.equal(usage.resetTime('month',new Date('2026-10-25T03:00:00Z')),'2026-10-31T17:00:00.000Z');
});

test('weekly limits run Monday to Sunday in Vietnam time and reset next Monday',async t=>{
 const service=isolated(t);
 assert.equal(usage.periodKeys(new Date('2026-10-25T16:59:00Z')).week,'w:2026-10-19');
 assert.equal(usage.periodKeys(new Date('2026-10-25T17:00:00Z')).week,'w:2026-10-26');
 assert.equal(usage.resetTime('week',new Date('2026-10-25T03:00:00Z')),'2026-10-25T17:00:00.000Z');
 await service.setLimit({scope:'account',targetId:'u1',period:'week',tokenLimit:100},'admin');
 await service.record({accountId:'u1',providerId:provider.id,tokens:100});
 await assert.rejects(service.check({accountId:'u1',provider}),error=>error.code==='AI_ACCOUNT_QUOTA'&&/tuần này/.test(error.message)&&/thứ Hai/.test(error.message));
 assert.equal((await service.accountStatus('u1')).period,'week');
});

test('resetting a user clears only their current usage and lets them ask again',async t=>{
 const service=isolated(t);
 await service.setLimit({scope:'account',targetId:'u1',period:'month',tokenLimit:100},'admin');
 await service.record({accountId:'u1',providerId:provider.id,tokens:150});
 await service.record({accountId:'u2',providerId:provider.id,tokens:40});
 await assert.rejects(service.check({accountId:'u1',provider}),error=>error.code==='AI_ACCOUNT_QUOTA');
 const result=await service.resetUsage({scope:'account',targetId:'u1'});
 assert.equal(result.cleared.month,150);
 await service.check({accountId:'u1',provider});
 const after=await service.usage();
 assert.equal(after['account|u1'],undefined);
 assert.equal(after['account|u2'].month,40);
 assert.equal(after['provider|local-1'].month,190);
 assert.equal((await service.limits()).find(item=>item.targetId==='u1').tokenLimit,100);
 await assert.rejects(service.resetUsage({scope:'team',targetId:'x'}),/không hợp lệ/);
});
