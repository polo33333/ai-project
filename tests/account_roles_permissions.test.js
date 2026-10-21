'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
test('custom roles and account overrides enforce functions and data scope over HTTP',async t=>{
  process.env.BOOTSTRAP_ADMIN_PASSWORD='test-admin-bootstrap';
  const auth=require('../src/backend/services/auth_service'), roles=require('../src/backend/services/account_roles');
  const sql=require('../src/backend/services/sql_connector'), dictionary=require('../src/backend/services/dictionary_service');
  const previous={accounts:auth.accounts,sessions:auth.sessions,roles:roles.roles,sources:sql.dbSources,tables:dictionary.tablesStore};
  t.after(()=>{auth.accounts=previous.accounts;auth.sessions=previous.sessions;roles.roles=previous.roles;sql.dbSources=previous.sources;dictionary.tablesStore=previous.tables;});
  t.mock.method(auth,'persistAccounts',()=>{});t.mock.method(auth,'persistSessions',()=>{});t.mock.method(sql,'persist',()=>{});
  auth.accounts=[{id:'root',username:'root',role:'admin',isActive:true,passwordHash:auth.hashPassword('root-test-pass')}];auth.sessions={};roles.roles=[];
  // Schema/source metadata only. No SQL connection or business rows are simulated.
  sql.dbSources=[{id:'s1',dbName:'ScopeOne',name:'Source one'},{id:'s2',dbName:'ScopeTwo',name:'Source two'}];
  dictionary.tablesStore=[{tableId:'t1',tableName:'ScopeOneTable',dbSourceId:'s1',columns:[]},{tableId:'t2',tableName:'ScopeTwoTable',dbSourceId:'s2',columns:[]}];
  const server=http.createServer((req,res)=>require('../src/backend/routes/router').handleRequest(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,root=auth.login('root','root-test-pass');
  async function call(path,method='GET',body,token=root.token){const r=await fetch(base+path,{method,headers:{Cookie:`kh_session=${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
  const role={id:'finance',name:'Kế toán',permissions:['chat.use','schema.read','sources.read','sql:read','workflows.use'],dataAccess:{sql:['s1'],documents:[]}};
  assert.equal((await call('/api/accounts/roles','POST',{...role,permissions:['admin']})).status,400);
  assert.equal((await call('/api/accounts/roles','POST',role)).status,200);
  assert.equal((await call('/api/accounts/roles','POST',role)).status,409);
  const fields={username:'scoped',displayName:'Scoped account',email:'',role:'finance',isActive:true,password:'scoped-test-pass',permissions:null,dataAccess:null};
  const created=await call('/api/accounts','POST',fields);assert.equal(created.status,201);const id=created.data.account.id;
  const user=auth.login('scoped',fields.password);assert.ok(user);assert.equal(user.account.role,'finance');assert.deepEqual(user.account.dataAccess.sql,['s1']);
  assert.equal((await call('/api/accounts/roles','GET',null,user.token)).status,403);
  assert.equal((await call('/api/library','GET',null,user.token)).status,403);
  assert.equal((await call('/api/accounts/roles','POST',{...role,id:'other'},user.token)).status,403);
  const tables=await call('/api/dictionary/workspace','GET',null,user.token);assert.equal(tables.status,200);assert.deepEqual(tables.data.tables.map(r=>r.tableId),['t1']);
  const sources=await call('/api/sql/sources','GET',null,user.token);assert.equal(sources.status,200);assert.deepEqual(sources.data.map(r=>r.id),['s1']);
  const updated=await call('/api/accounts/'+id,'PUT',{...fields,revision:1,permissions:['chat.use'],dataAccess:{sql:['s2'],documents:[]}});
  assert.equal(updated.status,200);assert.deepEqual(updated.data.account.permissions,['chat.use']);assert.deepEqual(updated.data.account.dataAccess.sql,[]);
  assert.equal(auth.getAccountBySession(user.token),null);
  const next=auth.login('scoped',fields.password);assert.equal((await call('/api/dictionary/workspace','GET',null,next.token)).status,403);
  assert.equal((await call('/api/accounts/roles/finance','PUT',{...role,revision:1,permissions:[]})).status,200);
  assert.equal(auth.getAccountBySession(next.token),null);
  assert.equal((await call('/api/accounts/roles/user','PUT',{...role,revision:0})).status,409);
});
test('custom role policy matching and per-account sources cannot bypass resource policy',async()=>{
  const context=require('../src/backend/governance/context');
  await context.run(async()=>{
    const actor={subject:'account:finance-user',role:'finance',permissions:['sql:read'],dataAccess:{sql:['s1'],documents:[]}};
    context.setPrincipal(actor);
    const source={id:'s1',dbName:'Metadata',governedPolicy:{visibility:'restricted',roles:['finance']}};
    assert.equal(context.canRead(source,'sql'),true);
    assert.equal(context.canRead({...source,id:'s2'},'sql'),false);
    assert.equal(context.canRead({...source,governedPolicy:{visibility:'restricted',roles:['other']}},'sql'),false);
    assert.equal(context.canRead({id:'document'},'document'),false);
    context.setPrincipal({...actor,permissions:[]});assert.equal(context.canRead(source,'sql'),false);
  });
});
