'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('admin login lives at /admin/login, / opens the chat client and old URLs redirect without weakening authentication', async t => {
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

  const login = await request('/admin/login');
  assert.equal(login.status, 200);
  assert.match(login.headers.get('content-type'), /^text\/html/);
  assert.match(login.headers.get('cache-control'), /no-store/);
  const loginHtml = await login.text();
  assert.match(loginHtml, /id="login-form"/);
  const { version } = require('../package.json');
  assert.ok(loginHtml.includes('Phiên bản v' + version));
  assert.ok(!loginHtml.includes('{{APP_VERSION}}'));
  const head = await request('/admin/login', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const alias of ['/login', '/login.html', '/login/', '/admin/login.html', '/admin/login/']) {
    const result = await request(alias + '?source=test');
    assert.equal(result.status, 308, alias);
    assert.equal(result.headers.get('location'), '/admin/login?source=test', alias);
  }
  assert.equal((await request('/')).headers.get('location'), '/chat');
  assert.equal((await request('/page-chat?x=1')).headers.get('location'), '/admin/page-chat?x=1');
  assert.equal((await request('/index.html')).headers.get('location'), '/admin');
  const privatePage = await request('/admin/page-chat');
  assert.equal(privatePage.status, 302);
  assert.equal(privatePage.headers.get('location'), '/admin/login');
  assert.equal((await request('/api/accounts')).status, 401);
  account = { id: 'login-route-user', role: 'user', permissions: [] };
  const signedIn = await request('/admin/login');
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get('location'), '/admin');
  assert.equal((await request('/api/accounts')).status, 403);
  // The admin page and the assets it loads come from admin-client/, then shared/, and /embed/* from embed-client/.
  account = { id: 'admin-user', role: 'admin' };
  const adminPage = await request('/admin/overview');
  assert.equal(adminPage.status, 200);
  assert.match(await adminPage.text(), /id="app-sidebar"/);
  for (const asset of ['/admin/js/core/main_tabs.js', '/admin/js/app.js', '/js/app.js', '/admin/embed/chat-stream.js', '/embed/knowledgehub-chat.js', '/favicon.svg', '/views/page_chat.html'])
    assert.equal((await request(asset)).status, 200, asset);
  assert.equal((await request('/admin/../package.json')).status, 404);
  assert.equal((await request('/embed/..%2F..%2Fpackage.json')).status, 404);
});
