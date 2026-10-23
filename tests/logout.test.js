'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');

test('logout expires the browser cookie, revokes only its own session and is safe to repeat', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'isolated-logout-test';
  const auth = require('../src/backend/services/auth_service');
  const previous = { accounts: auth.accounts, sessions: auth.sessions };
  auth.accounts = [{ id: 'logout-user', username: 'logout-user', role: 'user', isActive: true }];
  auth.sessions = Object.fromEntries(['current', 'other'].map(token => [token, { accountId: 'logout-user', expiresAt: Date.now() + 60000, persistedAt: Date.now() }]));
  t.mock.method(auth, 'persistSessions', () => {});
  t.after(() => { auth.accounts = previous.accounts; auth.sessions = previous.sessions; });
  const router = require('../src/backend/routes/router');
  const server = http.createServer((req, res) => router.handleRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: 'kh_session=current' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /kh_session=;.*Max-Age=0/i);
    assert.equal(auth.getAccountBySession('current'), null);
    assert.equal(auth.getAccountBySession('other', { touch: false }).id, 'logout-user');
  }
  const denied = await fetch(base + '/api/auth/me', { headers: { Cookie: 'kh_session=current' } });
  assert.equal((await denied.json()).authenticated, false);
});
