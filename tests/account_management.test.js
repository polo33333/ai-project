'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
test('admin account lifecycle enforces roles, validation, session revocation and private DTOs over HTTP', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'test-bootstrap-only';
  const auth = require('../src/backend/services/auth_service');
  const previous = { accounts: auth.accounts, sessions: auth.sessions };
  auth.accounts = [{ id:'owner', username:'owner', displayName:'Owner', role:'admin', isActive:true, passwordHash:auth.hashPassword('owner-test-password') }]; auth.sessions = {};
  t.after(() => { auth.accounts = previous.accounts; auth.sessions = previous.sessions; });
  t.mock.method(auth, 'persistAccounts', () => {}); t.mock.method(auth, 'persistSessions', () => {});
  const router = require('../src/backend/routes/router');
  const server = http.createServer((req,res) => router.handleRequest(req,res));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = token => `kh_session=${token}`;
  const owner = auth.login('owner', 'owner-test-password');
  async function call(path, method='GET', body, token=owner.token) {
    const response = await fetch(base + path, { method, headers:{'Content-Type':'application/json', Cookie:cookie(token)}, ...(body ? {body:JSON.stringify(body)} : {}) });
    return { status:response.status, data:await response.json() };
  }
  const fields = { username:'member', displayName:'Member', email:'member@example.test', role:'user', isActive:true, password:'member-test-password' };
  assert.equal((await call('/api/accounts','POST',{...fields,role:'superadmin'})).status,400);
  assert.equal((await call('/api/accounts','POST',{...fields,password:'short'})).status,400);
  const created = await call('/api/accounts','POST',fields); assert.equal(created.status,201);
  assert.ok(!JSON.stringify(created.data).includes('passwordHash')); assert.ok(!JSON.stringify(created.data).includes(fields.password));
  const id = created.data.account.id;
  assert.equal((await call('/api/accounts','POST',{...fields,username:'MEMBER'})).status,409);
  const member = auth.login('member',fields.password); assert.ok(member);
  assert.equal((await call('/api/accounts','GET',null,member.token)).status,403);
  assert.equal((await call('/api/accounts/'+id,'PUT',{...fields,revision:1},member.token)).status,403);
  assert.equal((await call('/api/accounts','GET',null,'not-a-session')).status,401);
  const promoted = await call('/api/accounts/'+id,'PUT',{...fields,role:'admin',revision:1}); assert.equal(promoted.status,200);
  assert.equal(auth.getAccountBySession(member.token),null);
  assert.equal((await call('/api/accounts/'+id,'PUT',{...fields,revision:1})).status,409);
  const reset = await call('/api/accounts/'+id+'/password','POST',{password:'new-member-password',revision:2}); assert.equal(reset.status,200);
  assert.equal(auth.login('member',fields.password),null);
  const newLogin = auth.login('member','new-member-password'); assert.ok(newLogin);
  assert.equal((await call('/api/accounts/'+id,'PUT',{...fields,isActive:false,revision:3})).status,200);
  assert.equal(auth.getAccountBySession(newLogin.token),null); assert.equal(auth.login('member','new-member-password'),null);
  assert.equal((await call('/api/accounts/owner','PUT',{...fields,role:'user',revision:0})).status,400);
  assert.equal((await call('/api/accounts/owner','PUT',{...fields,role:'admin',isActive:false,revision:0})).status,400);
  const listed = await call('/api/accounts'); assert.equal(listed.status,200); assert.equal(listed.data.accounts.length,2);
  assert.ok(!JSON.stringify(listed.data).includes('scrypt$'));
});
test('commit constraint rejects concurrent removal of last admin and duplicate usernames', () => {
  const { validateTransition } = require('../src/backend/services/account_constraints');
  const before=[{username:'a',role:'admin',isActive:true},{username:'b',role:'admin',isActive:true}];
  assert.throws(()=>validateTransition(before,before.map(a=>({...a,role:'user'}))),{code:'ACCOUNT_CONFLICT'});
  assert.throws(()=>validateTransition(before,[before[0],{...before[1],username:'A'}]),{code:'ACCOUNT_CONFLICT'});
  assert.doesNotThrow(()=>validateTransition(before,[before[0],{...before[1],role:'user'}]));
});
test('simultaneous management updates cannot bypass revision checks through field merging', () => {
  const { validateRevisions } = require('../src/backend/services/account_constraints');
  const before=[{id:'a',managementRevision:0}];
  assert.throws(()=>validateRevisions(before,[{id:'a',managementRevision:1}],[{id:'a',managementRevision:1}]),{code:'ACCOUNT_CONFLICT'});
  assert.doesNotThrow(()=>validateRevisions(before,before,[{id:'a',managementRevision:1}]));
});
test('sessions issued during a password change cannot bypass security version revocation', t => {
  const auth = require('../src/backend/services/auth_service'), accounts = auth.accounts, sessions = auth.sessions;
  auth.accounts=[{id:'u',username:'u',role:'user',isActive:true,securityVersion:2}];
  auth.sessions={old:{accountId:'u',securityVersion:1,expiresAt:Date.now()+100000},fresh:{accountId:'u',securityVersion:2,expiresAt:Date.now()+100000}};
  t.after(()=>{auth.accounts=accounts;auth.sessions=sessions;});
  assert.equal(auth.getAccountBySession('old',{touch:false}),null);
  assert.equal(auth.getAccountBySession('fresh',{touch:false}).id,'u');
});
