'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'isolated-standalone-chat-test';

async function startServer(t) {
  const router = require('../src/backend/routes/router');
  const server = http.createServer((req, res) => router.handleRequest(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  return (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
}

test('chat client at /chat shares one login session with the admin app at /admin', async t => {
  const auth = require('../src/backend/services/auth_service');
  const accounts = {};
  t.mock.method(auth, 'getAccountBySession', token => accounts[token] || null);
  t.mock.method(auth, 'login', username => username === 'chat-user'
    ? { token: 'new-token', maxAge: 60, account: { id: 'chat-user', role: 'user' } } : null);
  const logout = t.mock.method(auth, 'logout', () => {});
  const request = await startServer(t);
  const session = token => ({ headers: { cookie: 'kh_session=' + token } });

  assert.equal((await request('/')).headers.get('location'), '/chat');
  const signedOut = await request('/chat?embed=abc-1');
  assert.equal(signedOut.status, 302);
  assert.equal(signedOut.headers.get('location'), '/chat/login?embed=abc-1');
  // The chat client's own files live in chat-client/; its login script replaces the admin one.
  const chatLoginScript = await (await request('/chat/js/login.js')).text();
  assert.match(chatLoginScript, /\/chat\/api\/auth\/login/);
  assert.doesNotMatch(await (await request('/admin/js/login.js')).text(), /\/chat\/api\/auth\/login/);
  assert.equal((await request('/chat/css/chat.css')).status, 200);
  const login = await request('/chat/login');
  assert.equal(login.status, 200);
  const loginHtml = await login.text();
  assert.match(loginHtml, /id="kh-login-form"/);
  assert.ok(loginHtml.includes('v' + require('../package.json').version));
  assert.ok(!loginHtml.includes('{{APP_VERSION}}'));
  assert.equal(login.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal((await request('/chat/api/auth/me')).status, 200);
  assert.equal((await request('/chat/api/page-chat/sessions')).status, 401);

  const post = (path, body, options = {}) => request(path, { method: 'POST', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(body) });
  // One cookie for both clients; a framed chat login (embed "page" mode) gets a partitioned one.
  const chatLogin = await post('/chat/api/auth/login', { username: 'chat-user', password: 'x' });
  assert.equal(chatLogin.status, 200);
  assert.match(chatLogin.headers.get('set-cookie'), /^kh_session=new-token; HttpOnly; SameSite=Lax; Path=\/; Max-Age=60$/);
  const framedLogin = await post('/chat/api/auth/login', { username: 'chat-user', password: 'x', framed: true });
  assert.match(framedLogin.headers.get('set-cookie'), /^kh_frame_session=new-token; HttpOnly; Path=\/; SameSite=None; Secure; Partitioned; Max-Age=60$/);
  const adminFramed = await post('/api/auth/login', { username: 'chat-user', password: 'x', framed: true });
  assert.match(adminFramed.headers.get('set-cookie'), /^kh_session=new-token;/);
  // Signing in ends the browser's earlier session (another account, or one this account cannot keep).
  logout.mock.resetCalls();
  await post('/chat/api/auth/login', { username: 'chat-user', password: 'x' }, session('old-admin-token'));
  assert.deepEqual(logout.mock.calls.map(call => call.arguments), [['old-admin-token']]);

  accounts['shared-token'] = { id: 'chat-user', role: 'user', permissions: ['chat.use', 'dashboard.read'] };
  const page = await request('/chat', session('shared-token'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /no-store/);
  const html = await page.text();
  assert.match(html, /data-page="chat"/);
  assert.match(html, /<base href="\/chat\/">/);
  assert.equal((await request('/admin/overview', session('shared-token'))).status, 200);
  assert.equal((await request('/chat/js/modules/page_chat.js', session('shared-token'))).status, 200);
  assert.equal((await request('/chat/embed/chat-stream.js', session('shared-token'))).status, 200);
  assert.equal((await request('/chat/views/page_chat.html', session('shared-token'))).status, 200);
  const me = await (await request('/chat/api/auth/me', session('shared-token'))).json();
  assert.equal(me.account.id, 'chat-user');
  assert.equal((await request('/chat/login?embed=abc-1', session('shared-token'))).headers.get('location'), '/chat?embed=abc-1');
  for (const adminPage of ['/chat/settings', '/chat/page-chat', '/chat/index.html']) {
    const result = await request(adminPage, session('shared-token'));
    assert.equal(result.status, 302, adminPage);
    assert.equal(result.headers.get('location'), '/chat', adminPage);
  }
  // The framed cookie signs in only when the shared one is absent (inside the customer's frame).
  accounts['frame-token'] = accounts['shared-token'];
  assert.equal((await request('/chat', { headers: { cookie: 'kh_frame_session=frame-token' } })).status, 200);
  const logoutResponse = await request('/chat/api/auth/logout', { method: 'POST', ...session('shared-token') });
  assert.match(logoutResponse.headers.get('set-cookie'), /^kh_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/);

  accounts['no-chat'] = { id: 'no-chat', role: 'user', permissions: ['dashboard.read'] };
  assert.equal((await request('/chat', session('no-chat'))).status, 403);
});

test('page-chat embed mode lets only its domains frame the chat client', async t => {
  const embed = require('../src/backend/services/embed_chat_service');
  const config = embed.createConfig({ name: 'Cổng khách hàng', allowedOrigins: 'https://portal.example.com', mode: 'page' });
  const widget = embed.createConfig({ name: 'Website', allowedOrigins: 'https://www.example.com' });
  t.after(() => { embed.deleteConfig(config.id); embed.deleteConfig(widget.id); });
  assert.equal(config.mode, 'page');
  assert.equal(widget.mode, 'widget');
  assert.equal(embed.updateConfig(widget.id, { name: 'Website', allowedOrigins: 'https://www.example.com', mode: 'other' }).mode, 'widget');
  const request = await startServer(t);

  const framed = await request('/chat/login?embed=' + config.id);
  assert.equal(framed.headers.get('content-security-policy'), "frame-ancestors 'self' https://portal.example.com");
  assert.equal((await request('/chat/login?embed=' + widget.id)).headers.get('content-security-policy'), "frame-ancestors 'self'");
  embed.toggleConfig(config.id, false);
  assert.equal((await request('/chat/login?embed=' + config.id)).headers.get('content-security-policy'), "frame-ancestors 'self'");
  embed.toggleConfig(config.id, true);

  const presence = await request('/api/embed/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://portal.example.com' },
    body: JSON.stringify({ embedId: config.id, sessionId: 'visitor-1', presence: true }) });
  assert.deepEqual(await presence.json(), { status: 'success', mode: 'page' });
});

test('embed widget switches to the chat client frame in page mode', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/frontend/embed-client/knowledgehub-chat.js'), 'utf8');
  assert.match(source, /if \(data\?\.mode\) applyEmbedMode\(data\.mode\)/);
  assert.match(source, /frame\.src = apiBase \+ '\/chat\?embed=' \+ encodeURIComponent\(embedId\)/);
  // Page mode also offers the chat client in a new tab; the old widget does not show it.
  assert.match(source, /class="kh-embed-newtab" href="\$\{escapeHtml\(apiBase \+ '\/chat'\)\}" target="_blank" rel="noopener"/);
  assert.match(source, /\.kh-embed-newtab\{display:none;[^}]*\}.*\.kh-embed-root\.page-mode \.kh-embed-newtab\{display:grid\}/);
});

test('chat client requests load the same app stores as the routes they stand for', () => {
  const { requestStores } = require('../src/backend/storage/request_stores');
  const stores = (method, url) => requestStores({ method, url });
  assert.deepEqual(stores('GET', '/chat/api/ai-usage/me'), stores('GET', '/api/ai-usage/me'));
  assert.deepEqual(stores('GET', '/chat/api/chat/providers'), stores('GET', '/api/chat/providers'));
  assert.deepEqual(stores('POST', '/chat/api/page-chat/sessions'), stores('POST', '/api/page-chat/sessions'));
  assert.deepEqual(stores('POST', '/chat/api/intelligent-core/chat/stream'), stores('POST', '/api/intelligent-core/chat/stream'));
  assert.ok(!stores('POST', '/chat/api/intelligent-core/chat/stream').includes('chat_history.json'));
  assert.deepEqual(stores('GET', '/admin/api/accounts'), stores('GET', '/api/accounts'));
  for (const page of ['/chat', '/chat/', '/chat?embed=x', '/chat/login?embed=x']) assert.ok(stores('GET', page).includes('embed_chat_configs.json'), page);
  for (const page of ['/login', '/admin/login', '/admin']) assert.ok(!stores('GET', page).includes('embed_chat_configs.json'), page);
});

test('account client access limits sign-in to the chat client, the admin app or both', async t => {
  const auth = require('../src/backend/services/auth_service');
  const accounts = {
    'chat-only': { id: 'chat-only', role: 'user', permissions: ['chat.use'], clientAccess: 'chat' },
    'admin-only': { id: 'admin-only', role: 'user', permissions: ['chat.use', 'dashboard.read'], clientAccess: 'admin' },
    both: { id: 'both', role: 'user', permissions: ['chat.use', 'dashboard.read'], clientAccess: 'both' }
  };
  t.mock.method(auth, 'getAccountBySession', token => accounts[token] || null);
  let loginAccess = 'chat';
  t.mock.method(auth, 'login', () => ({ token: 'login-token', maxAge: 60, account: { id: 'x', role: 'user', clientAccess: loginAccess } }));
  const logout = t.mock.method(auth, 'logout', () => {});
  const request = await startServer(t);
  // Both clients read the same cookie; the account's client access decides what it opens.
  const session = token => ({ headers: { cookie: 'kh_session=' + token } });
  const me = async options => (await (await request('/api/auth/me', options)).json()).authenticated;
  const chatMe = async options => (await (await request('/chat/api/auth/me', options)).json()).authenticated;

  assert.equal((await request('/chat', session('chat-only'))).status, 200);
  assert.equal(await me(session('chat-only')), false);
  assert.equal((await request('/admin', session('chat-only'))).headers.get('location'), '/admin/login');
  assert.equal((await request('/chat', session('admin-only'))).headers.get('location'), '/chat/login');
  assert.equal(await chatMe(session('admin-only')), false);
  assert.equal(await me(session('admin-only')), true);
  assert.equal(await me(session('both')), true);
  assert.equal(await chatMe(session('both')), true);

  const post = path => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
  const refused = await post('/api/auth/login');
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('set-cookie'), null);
  assert.match((await refused.json()).message, /chỉ được dùng trang trò chuyện/);
  // A refused login leaves the browser's current session alone.
  assert.deepEqual(logout.mock.calls.at(-1).arguments, ['login-token']);
  assert.equal((await post('/chat/api/auth/login')).status, 200);
  loginAccess = 'admin';
  assert.equal((await post('/chat/api/auth/login')).status, 403);
  assert.equal((await post('/api/auth/login')).status, 200);
});

test('client access is saved on accounts and keeps one admin able to manage', () => {
  const auth = require('../src/backend/services/auth_service');
  const owner = auth.accounts.find(account => account.role === 'admin');
  const base = { displayName: 'Người dùng chat', email: '', role: 'user', isActive: true };
  const created = auth.createAccount(owner.id, { ...base, username: 'chat-client-user', password: 'mat-khau-thu-1', clientAccess: 'chat' });
  assert.equal(created.clientAccess, 'chat');
  assert.equal(auth.canUseClient(created, 'chat'), true);
  assert.equal(auth.canUseClient(created, 'admin'), false);
  assert.equal(auth.clientAccess({}), 'both');
  assert.throws(() => auth.createAccount(owner.id, { ...base, username: 'bad-access', password: 'mat-khau-thu-1', clientAccess: 'web' }), /Phạm vi sử dụng/);
  const ownerFields = { displayName: owner.displayName || owner.username, email: owner.email || '', role: 'admin', isActive: true };
  assert.throws(() => auth.updateAccount(owner.id, owner.id, { ...ownerFields, clientAccess: 'chat', revision: owner.managementRevision || 0 }), /trang quản lý/);
  const updated = auth.updateAccount(owner.id, created.id, { ...base, clientAccess: 'both', revision: created.revision });
  assert.equal(updated.clientAccess, 'both');
});
