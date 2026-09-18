'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');
const { migrate } = require('../src/backend/storage/postgres/migrate');
const { importSnapshot } = require('../scripts/postgres/transfer');
const { buildModel, canonical } = require('../scripts/postgres/model');

test('PostgreSQL runtime stores app mutations and protects concurrent chat writes', { skip: process.env.KNOWLEDGEHUB_TEST_POSTGRES !== '1' }, async t => {
  loadEnvironment();
  const database = 'knowledgehub_test_' + crypto.randomBytes(8).toString('hex');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgehub-pg-runtime-'));
  process.env.APP_STORAGE_BACKEND = 'postgres';
  process.env.KNOWLEDGEHUB_DATA_DIR = temp;
  process.env.APP_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const salt = 'test-salt';
  const passwordHash = 'scrypt$' + salt + '$' + crypto.scryptSync('test-password-only', salt, 64).toString('hex');
  const input = new Map([
    ['accounts.json', [{ id: 'a', username: 'admin', role: 'admin', passwordHash, isActive: true }]],
    ['sessions.json', {}],
    ['ai_providers.json', [{ id: 'p', name: 'Test', model: 'test', apiFormat: 'openai', baseUrl: 'http://127.0.0.1', apiKey: 'test-secret', isActive: true }]],
    ['api_keys.json', []], ['dictionary.json', []], ['table_relationships.json', []], ['glossary.json', [{ term:'legacy-term', fullMeaning:'test' }]],
    ['domain_aliases.json', {}], ['conversation_memory.json', { sessions: {} }],
    ['chat_history.json', []], ['chat_feedback.json', []], ['logs.json', []],
    ['embed_chat_configs.json', [{ id: 'embed', name:'Test', isActive: true, allowedOrigins:['http://allowed.test'], rateLimit:100, maxQuestionLength:4000, maxHistory:10, maxRows:100 }]],
    ['workflows.json', []], ['workflow_runs.json', []], ['library.json', []], ['watchfolders.json', []], ['watchfolder_logs.json', []]
  ]);
  const admin = createPool({ bootstrap: true });
  let pool;
  let storage;
  let server;
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    pool = createPool({ bootstrap: true, database });
    await migrate(pool);
    await importSnapshot(pool, { model: buildModel(input), manifest: { snapshotHash: crypto.createHash('sha256').update(canonical([...input])).digest('hex') } });
    await pool.query("UPDATE app.storage_state SET mode='live'");
    storage = require('../src/backend/storage');
    await storage.bootstrapStorage({ pool });
    let logger, memory, providers, auth, router, core;
    await storage.run(() => {
      logger = require('../src/backend/services/logger_service');
      memory = require('../src/backend/memory_core').memoryService;
      providers = require('../src/backend/services/ai_provider_manager');
      auth = require('../src/backend/services/auth_service');
      router = require('../src/backend/routes/router');
      core = require('../src/backend/intelligent_core/core');
    });
    const exchange = (sessionId, question) => memory.persistSuccessfulExchange({ sessionId, accountId:'a', question, reply:'Verified reply ' + question,
      completionStatus:'SUCCESS', responseEvaluation:{valid:true,failures:[]}, currentPlan:{table:'Contract'} });

    await t.test('memory, audit and logs persist without creating JSON files', async () => {
      await storage.run(() => { exchange('s', 'First'); logger.addChatAudit('First','Verified reply First',null,providers.getActiveProvider(),1); });
      await storage.run(() => assert.equal(memory.getSession('s',false,'a').messages.length,2));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.chat_runs')).rows[0].n,1);
      assert.equal(fs.readdirSync(temp).filter(name => name.endsWith('.json')).length,0);
    });
    await t.test('scoped page reads load only requested domains and refuse accidental unloaded access',async()=>{
      const repo=new(require('../src/backend/storage/postgres/repository').PostgresRepository)(pool);
      const snapshot=await repo.snapshot(['accounts.json','sessions.json']);
      assert.equal(snapshot.documents.size,2);
      assert.deepEqual(snapshot.model.rows.chat_runs,[]);
      assert.deepEqual(snapshot.model.rows.chat_messages,[]);
      await storage.run(()=>{
        assert.throws(()=>providers.getProviders(),/Store not loaded/);
        assert.throws(()=>storage.write('chat_history.json',[]),/Store not loaded/);
      },{files:['accounts.json','sessions.json']});
    });
    await t.test('concurrent exchanges to the same existing session preserve both pairs', async () => {
      let release;
      const barrier = new Promise(resolve => { release=resolve; });
      let entered=0;
      await Promise.all(['Second','Third'].map(question => storage.run(async () => {
        exchange('s', question);
        if (++entered===2) release(); await barrier;
        logger.addChatAudit(question,'Verified reply '+question,null,providers.getActiveProvider(),1);
      })));
      await storage.run(() => {
        const messages=memory.getSession('s',false,'a').messages;
        assert.equal(messages.length,6);
        assert.ok(messages.some(message => message.content==='Second'));
        assert.ok(messages.some(message => message.content==='Third'));
      });
    });
    await t.test('concurrent first turns preserve messages and isolate account ownership', async () => {
      await Promise.all(['One','Two'].map(question => storage.run(() => exchange('new-session',question))));
      await storage.run(() => {
        assert.equal(memory.getSession('new-session',false,'a').messages.length,4);
        assert.equal(memory.getSession('new-session',false,'other-account'),null);
      });
    });
    await t.test('PARTIAL never enters successful memory', async () => {
      await storage.run(() => {
        assert.equal(memory.persistSuccessfulExchange({sessionId:'partial',accountId:'a',question:'Question',reply:'Raw SQL',completionStatus:'PARTIAL',responseEvaluation:{valid:false,failures:['MISSING_SQL']}}).persisted,false);
      });
      await storage.run(() => assert.equal(memory.getSession('partial',false,'a'),null));
    });
    await t.test('conflicting configuration edits reject without losing the first edit', async () => {
      let release; const barrier=new Promise(resolve => {release=resolve;}); let entered=0;
      const results=await Promise.allSettled(['Name A','Name B'].map(name => storage.run(async () => {
        providers.updateProvider('p',{name}); if(++entered===2)release(); await barrier;
      })));
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(results.find(result=>result.status==='rejected').reason.code,'DATA_CONFLICT');
    });
    await t.test('concurrent watchfolder scan statistics preserve the latest scan', async () => {
      await storage.run(() => storage.write('watchfolders.json', [{id:'scan-test',lastScan:'2026-09-18T01:00:00Z',scannedFiles:1}]));
      let release; const barrier = new Promise(resolve => {release=resolve;}); let entered=0;
      await Promise.all([2,3].map(count => storage.run(async () => {
        const folders=storage.read('watchfolders.json',[]);
        folders[0].lastScan=`2026-09-18T0${count}:00:00Z`; folders[0].scannedFiles=count;
        storage.write('watchfolders.json',folders);
        if(++entered===2)release(); await barrier;
      })));
      await storage.run(() => assert.equal(storage.read('watchfolders.json',[])[0].scannedFiles,3));
    });
    await t.test('failed commit rolls back the message pair and audit together', async () => {
      const before=(await pool.query('SELECT count(*)::int AS n FROM app.chat_runs')).rows[0].n;
      await assert.rejects(storage.run(() => {
        exchange('rolled-back','Rollback'); logger.addChatAudit('Rollback','Verified reply',null,providers.getActiveProvider(),1);
        storage.enqueue('invalid-job',null,{});
      }));
      await storage.run(() => assert.equal(memory.getSession('rolled-back',false,'a'),null));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.chat_runs')).rows[0].n,before);
    });
    await t.test('memory retention preserves complete pairs while trimming old rows', async () => {
      for(let i=0;i<22;i++)await storage.run(()=>exchange('retention','Turn '+i));
      await storage.run(()=>{
        const messages=memory.getSession('retention',false,'a').messages;
        assert.equal(messages.length,40); assert.equal(messages[0].content,'Turn 2');
        assert.equal(messages.at(-1).content,'Verified reply Turn 21');
      });
    });
    await t.test('provider selection stays unique after editing an inactive provider', async () => {
      const second=await storage.run(()=>providers.addProvider({name:'Second',apiFormat:'openai'}));
      await storage.run(()=>providers.updateProvider(second.id,{name:'Edited inactive'}));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.ai_providers WHERE is_active')).rows[0].n,1);
      await storage.run(()=>providers.setActiveProvider(second.id));
      await storage.run(()=>assert.equal(providers.getActiveProvider().id,second.id));
      await storage.run(()=>providers.deleteProvider(second.id));
      await storage.run(()=>assert.equal(providers.getActiveProvider().id,'p'));
    });
    await t.test('all domain stores support edits without changing legacy IDs or losing child records', async () => {
      const helper=require('../src/backend/utils/storage_helper');
      await storage.run(()=>{
        helper.saveJson('db_sources.json',[{id:'source',dbName:'Business',password:'source-secret'}]);
        helper.saveJson('dictionary.json',[{tableId:'table',tableName:'Contracts',dbSourceId:'source',columns:[{columnId:'col',columnName:'Name',description:'Tiếng Việt'}]}]);
        helper.saveJson('domain_aliases.json',{customer:['khách hàng','KH'],empty:[]});
        helper.saveJson('skills.json',{version:3,skills:[{id:'skill',name:'Test'}]});
        helper.saveJson('workflows.json',[{id:'wf',name:'Test',webhookSecret:'workflow-secret',steps:[{id:'step',type:'calculate'}]}]);
        helper.saveJson('workflow_runs.json',[{runId:'run',workflowId:'wf',state:{value:1},trace:{step:{success:true}}}]);
        helper.saveJson('training/regression_cases.json',[{id:'case',question:'Test'}]);
        helper.saveJson('training_resolutions.json',{case:{resolved:true}});
        helper.saveJson('mcp_servers.json',[{id:'mcp',name:'Test',headers:{Authorization:'mcp-secret'}}]);
        const glossary=helper.loadJson('glossary.json',[]); glossary[0].fullMeaning='Updated'; helper.saveJson('glossary.json',glossary);
      });
      const glossaryId=(await pool.query('SELECT id FROM app.glossary_terms')).rows[0].id;
      assert.equal(glossaryId,'legacy:glossary_terms:0');
      await storage.run(()=>{
        assert.equal(helper.loadJson('dictionary.json')[0].columns[0].description,'Tiếng Việt');
        assert.deepEqual(helper.loadJson('domain_aliases.json').empty,[]);
        assert.equal(helper.loadJson('skills.json').version,3);
        assert.equal(helper.loadJson('workflows.json')[0].webhookSecret,'workflow-secret');
      });
      await storage.run(()=>helper.saveJson('glossary.json',[]));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.glossary_terms')).rows[0].n,0);
    });
    await t.test('new auth sessions preserve login, touch, revoke and encrypted tokens', async () => {
      const session=await storage.run(()=>auth.login('admin','test-password-only'));
      assert.ok(session.token);
      await storage.run(()=>assert.equal(auth.getAccountBySession(session.token).id,'a'));
      const raw=JSON.stringify((await pool.query('SELECT * FROM app.auth_sessions')).rows);
      assert.ok(!raw.includes(session.token));
      await storage.run(()=>auth.logout(session.token));
      await storage.run(()=>assert.equal(auth.getAccountBySession(session.token),null));
    });

    const { handleStoredRequest }=require('../src/backend/storage/http');
    t.mock.method(core,'chat',async (question,options)=>{
      options.onProgress?.({type:'running',label:'Working'});
      return {success:true,replyText:'Verified answer',toolCalls:[],sqlExecutions:[],usedProvider:{id:'p',name:'Test',model:'test'},
        trace:{completionStatus:question==='partial'?'PARTIAL':'SUCCESS',memoryDecision:{accountId:'a',sessionId:options.session?.id},training:{plan:{table:'Contract'},responseEvaluation:{valid:question!=='partial',failures:question==='partial'?['MISSING_SQL']:[]}}}};
    });
    server=http.createServer((req,res)=>handleStoredRequest(req,res,async(req,res)=>{
      if(req.url==='/fixture/failed-commit') {
        storage.enqueue('invalid',null,{}); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"status":"success"}'); return;
      }
      if(req.url==='/fixture/failed-sse') {
        storage.enqueue('invalid',null,{}); res.writeHead(200,{'Content-Type':'text/event-stream'}); res.flushHeaders();
        res.write('event: progress\ndata: {}\n\n'); res.write('event: final\ndata: {"status":"success"}\n\n');res.end();return;
      }
      return router.handleRequest(req,res);
    }));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-password-only'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    await t.test('static views and dictionary API retain authorization with reduced store reads',async()=>{
      const script=await fetch(base+'/js/theme.js'); assert.equal(script.status,200);
      const dictionary=await fetch(base+'/api/dictionary',{headers:{Cookie:cookie}});assert.equal(dictionary.status,200);
      const providersResponse=await fetch(base+'/api/ai-providers',{headers:{Cookie:cookie}});assert.equal(providersResponse.status,200);
      for(const route of ['/api/providers','/api/glossary','/api/dictionary/relationships','/api/embed/configs','/api/logs','/api/chat-history','/api/chat-feedback','/api/mcp/servers','/api/keys','/api/tools','/api/training/skills','/api/training-report','/api/watchfolder','/api/watchfolder/logs','/api/workflows','/api/workflows/runs','/api/library']) {
        const response=await fetch(base+route,{headers:{Cookie:cookie}});assert.equal(response.status,200,route+': '+await response.text());
      }
      const protectedView=await fetch(base+'/views/page_chat.html',{redirect:'manual'});assert.ok([302,401].includes(protectedView.status));
    });
    const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
    await t.test('HTTP and SSE responses arrive after persisted audit, with PARTIAL gate intact', async () => {
      const normal=await post('/api/intelligent-core/chat',{question:'HTTP question',sessionId:'http-session'});
      assert.equal(normal.status,200); const data=await normal.json();
      assert.ok(data.auditId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.chat_runs WHERE id=$1',[data.auditId])).rows[0].n,1);
      const stream=await post('/api/intelligent-core/chat/stream',{question:'partial',sessionId:'sse-session'});
      const text=await stream.text();
      assert.match(text,/event: progress/); assert.match(text,/event: final/); assert.match(text,/"completionStatus":"PARTIAL"/);
      await storage.run(()=>assert.equal(memory.getSession('sse-session',false,'a')?.messages.length || 0,0));
    });
    await t.test('all configuration and history reads reflect PostgreSQL, not stale files', async () => {
      const response=await post('/api/persona',{name:'PG Persona'}); assert.equal(response.status,200);
      const read=await fetch(base+'/api/persona',{headers:{Cookie:cookie}}); assert.equal((await read.json()).name,'PG Persona');
      assert.equal(fs.existsSync(path.join(temp,'ai_persona.json')),false);
      const history=await fetch(base+'/api/chat-history',{headers:{Cookie:cookie}}); assert.ok((await history.json()).length>=4);
    });
    await t.test('failed commits never deliver a successful HTTP or SSE final response', async () => {
      const response=await post('/fixture/failed-commit',{}); assert.equal(response.status,503);
      assert.equal((await response.json()).message,'STORAGE_OPERATION_FAILED');
      const stream=await post('/fixture/failed-sse',{});const text=await stream.text();
      assert.match(text,/event: progress/);assert.match(text,/event: error/);assert.doesNotMatch(text,/event: final/);
    });
    await t.test('embed and API chat audit use PostgreSQL and embed memory owns its scope', async () => {
      const embed=await fetch(base+'/api/embed/chat',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://allowed.test'},body:JSON.stringify({embedId:'embed',sessionId:'same-client-id',question:'embed question'})});
      assert.equal(embed.status,200);const result=await embed.json();assert.ok(result.auditId);
      const owner=(await pool.query("SELECT owner_scope FROM app.chat_sessions WHERE embed_id='embed'")).rows[0];
      assert.equal(owner.owner_scope,'embed:embed');
      const api=await post('/api/chat',{message:'API question'});assert.equal(api.status,200);
      const compat=await post('/api/v1/chat/completions',{messages:[{role:'user',content:'Compatible question'}]});assert.equal(compat.status,200);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.chat_runs WHERE id=$1',[result.auditId])).rows[0].n,1);
    });
    await t.test('retrying the same chat request returns its committed response without duplicating memory/audit',async()=>{
      const request={question:'Idempotent request',sessionId:'idempotent'};
      const send=body=>fetch(base+'/api/intelligent-core/chat',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-Request-Id':'test-retry-id'},body:JSON.stringify(body)});
      const first=await(await send(request)).json();const second=await(await send(request)).json();
      assert.equal(second.auditId,first.auditId);
      await storage.run(()=>assert.equal(memory.getSession('idempotent',false,'a').messages.length,2));
      const conflict=await send({...request,question:'Changed body'});assert.equal(conflict.status,409);
    });
    await t.test('document ingest/delete jobs survive outside the HTTP request', async () => {
      const library=require('../src/backend/knowledge_core/services/library_service');
      const qdrant=require('../src/backend/services/qdrant_service');
      t.mock.method(qdrant,'indexDocumentChunks',async()=>({success:true}));
      t.mock.method(qdrant,'deleteDocumentChunks',async()=>({success:true}));
      const document=await storage.run(()=>library.addDocument({title:'Test.txt',fileType:'TXT',contentBase64:Buffer.from('Enterprise document test content').toString('base64')}));
      assert.equal(document.status,'Đang xử lý');
      const outbox=require('../src/backend/storage/postgres/outbox');
      assert.equal(await outbox.processOne(),true);
      await storage.run(()=>assert.equal(library.findDocument(document.id).status,'Đã lập chỉ mục'));
      await storage.run(()=>library.deleteDocument(document.id));
      assert.equal(await outbox.processOne(),true);
      assert.equal(fs.existsSync(document.storagePath),false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM app.outbox_jobs WHERE status='done'")).rows[0].n,2);
    });
    await t.test('runtime service access outside an operation fails explicitly', () => assert.throws(()=>providers.getProviders(),/awaited storage operation/));
    await t.test('page chat history is account scoped, versioned and separate from AI memory', async () => {
      const service=require('../src/backend/services/page_chat_history_service');
      const session={id:'ui-session',title:'Vietnamese chat',messages:[{role:'assistant',html:'PARTIAL result',completionStatus:'PARTIAL'}],history:[],version:0};
      const first=await service.save('a',{changes:[session]}); assert.equal(first.versions[session.id],1);
      assert.equal((await service.list('a'))[0].messages[0].completionStatus,'PARTIAL');
      assert.deepEqual(await service.list('other-account'),[]);
      await assert.rejects(service.save('a',{changes:[session]}),error=>error.statusCode===409);
      await assert.rejects(service.save('a',{changes:[{...session,id:'rollback-ui'}, {...session,version:0}]}),error=>error.statusCode===409);
      assert.equal((await service.list('a')).length,1);
      await storage.run(()=>assert.equal(memory.getSession(session.id,false,'a'),null));
      const raw=JSON.stringify((await pool.query('SELECT payload FROM app.ui_chat_sessions')).rows);
      assert.ok(!raw.includes('PARTIAL result'));
      const response=await post('/api/page-chat/sessions',{changes:[{...session,title:'Renamed',version:1}]});
      assert.equal(response.status,200);
      const list=await fetch(base+'/api/page-chat/sessions',{headers:{Cookie:cookie}});
      assert.equal((await list.json()).sessions[0].title,'Renamed');
      const anonymous=await fetch(base+'/api/page-chat/sessions');assert.equal(anonymous.status,401);
      await service.save('a',{deleted:[{id:session.id,version:2}]});assert.deepEqual(await service.list('a'),[]);
    });
    await t.test('runtime role has CRUD access but cannot change schema/import/cutover state', async () => {
      await require('../src/backend/storage/postgres/permissions').grantRuntime(pool);
      const runtime=createPool({runtime:true,database});
      try {
        assert.equal((await runtime.query('SELECT count(*)::int AS n FROM app.chat_runs')).rows[0].n>0,true);
        await assert.rejects(runtime.query("UPDATE app.storage_state SET mode='staging'"),error=>error.code==='42501');
        await assert.rejects(runtime.query("DELETE FROM app.import_batches"),error=>error.code==='42501');
        await assert.rejects(runtime.query('CREATE TABLE app.forbidden(id text)'),error=>error.code==='42501');
        const repo=new(require('../src/backend/storage/postgres/repository').PostgresRepository)(runtime);
        const loaded=await repo.snapshot();assert.ok(loaded.documents.has('chat_history.json'));
      }finally{await runtime.end();}
    });
    await t.test('password change verifies current password and atomically revokes all sessions',async()=>{
      const change=body=>post('/api/auth/change-password',body);
      const wrong=await change({currentPassword:'wrong',newPassword:'new-test-password'});assert.equal(wrong.status,400);
      const short=await change({currentPassword:'test-password-only',newPassword:'short'});assert.equal(short.status,400);
      const anonymous=await fetch(base+'/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(anonymous.status,401);
      const success=await change({currentPassword:'test-password-only',newPassword:'new-test-password'});assert.equal(success.status,200);
      assert.match(success.headers.get('set-cookie'),/Max-Age=0/);
      const oldSession=await fetch(base+'/api/auth/me',{headers:{Cookie:cookie}});assert.equal((await oldSession.json()).authenticated,false);
      await storage.run(()=>{
        assert.equal(auth.login('admin','test-password-only'),null);
        assert.ok(auth.login('admin','new-test-password'));
      });
    });
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    if(storage)await storage.close(); else if(pool)await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`); await admin.end();
  }
});
