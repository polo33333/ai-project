'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('clean login URL serves the login page and legacy URLs redirect without weakening authentication', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'isolated-login-route-test';
  const auth = require('../src/backend/services/auth_service');
  let account = null;
  t.mock.method(auth, 'getAccountBySession', () => account);
  const router = require('../src/backend/routes/router');
  const server = http.createServer((req, res) => router.handleRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });

  const login = await request('/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type'), /^text\/html/);
  assert.match(login.headers.get('cache-control'), /no-store/);
  const loginHtml = await login.text();
  assert.match(loginHtml, /id="login-form"/);
  const { version } = require('../package.json');
  assert.ok(loginHtml.includes('Phiên bản v' + version));
  assert.ok(!loginHtml.includes('{{APP_VERSION}}'));
  const head = await request('/login', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const alias of ['/login.html', '/login/']) {
    const result = await request(alias + '?source=test');
    assert.equal(result.status, 308);
    assert.equal(result.headers.get('location'), '/login?source=test');
    const legacyHead = await request(alias, { method: 'HEAD' });
    assert.equal(legacyHead.status, 308);
    assert.equal(legacyHead.headers.get('location'), '/login');
  }
  const privatePage = await request('/page-chat');
  assert.equal(privatePage.status, 302);
  assert.equal(privatePage.headers.get('location'), '/login');
  assert.equal((await request('/api/accounts')).status, 401);
  account = { id: 'login-route-user', role: 'user', permissions: [] };
  const signedIn = await request('/login');
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get('location'), '/');
  assert.equal((await request('/api/accounts')).status, 403);
});
