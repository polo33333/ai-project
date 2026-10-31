'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const assets = require('../src/backend/services/http_assets');

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('page asset links carry the file fingerprint; missing and external files stay as written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-assets-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.writeFileSync(path.join(dir, 'js/app.js'), 'console.log(1)');
  const stats = fs.statSync(path.join(dir, 'js/app.js'));
  const html = '<script defer src="js/app.js?v=old"></script><link href="/js/app.js"><script src="js/gone.js?v=1"></script><link href="https://cdn.example/x.css">';
  const out = assets.versionAssetLinks(html, url => path.join(dir, url));
  const version = assets.fingerprint(stats);
  assert.match(out, new RegExp(`src="js/app.js\\?v=${version}"`));
  assert.match(out, new RegExp(`href="/js/app.js\\?v=${version}"`));
  assert.match(out, /src="js\/gone.js\?v=1"/);
  assert.match(out, /href="https:\/\/cdn.example\/x.css"/);
});

test('static files: fingerprinted URL is cached for good, others revalidate with ETag and 304', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-assets-'));
  const filePath = path.join(dir, 'app.js');
  fs.writeFileSync(filePath, 'const value = 1;\n'.repeat(400));
  const stats = fs.statSync(filePath);
  await serve((req, res) => assets.sendStaticFile(req, res, { filePath, content: fs.readFileSync(filePath), stats,
    contentType: 'application/javascript; charset=UTF-8', version: new URL(req.url, 'http://x').searchParams.get('v') }), async base => {
    const fresh = await get(`${base}/app.js?v=${assets.fingerprint(stats)}`, { 'Accept-Encoding': 'br' });
    assert.equal(fresh.headers['cache-control'], 'private, max-age=31536000, immutable');
    assert.equal(fresh.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(fresh.body).toString(), fs.readFileSync(filePath, 'utf8'));
    const stale = await get(`${base}/app.js?v=manual-1`, { 'Accept-Encoding': 'gzip' });
    assert.equal(stale.headers['cache-control'], 'private, no-cache');
    assert.equal(stale.headers['content-encoding'], 'gzip');
    const again = await get(`${base}/app.js`, { 'If-None-Match': stale.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    const plain = await get(`${base}/app.js`);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), fs.readFileSync(filePath, 'utf8'));
  });
});

test('JSON responses are compressed; small, streamed and non-JSON responses pass through', async () => {
  const big = { rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `Bảng ${i}` })) };
  await serve((req, res) => {
    assets.compressJsonResponses(req, res);
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': 999 }); res.end(JSON.stringify(big)); }
    else if (req.url === '/set') { res.statusCode = 201; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(big)); }
    else if (req.url === '/small') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); }
    else if (req.url === '/stream') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); res.write('{"a":1}\n'); res.end('{"b":2}\n'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write(JSON.stringify(big)); res.end(); }
  }, async base => {
    const bigRes = await get(`${base}/big`, { 'Accept-Encoding': 'gzip, br' });
    assert.equal(bigRes.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(bigRes.body)), big);
    const setRes = await get(`${base}/set`, { 'Accept-Encoding': 'gzip' });
    assert.equal(setRes.status, 201);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(setRes.body)), big);
    const small = await get(`${base}/small`, { 'Accept-Encoding': 'br' });
    assert.equal(small.status, 404);
    assert.equal(small.headers['content-encoding'], undefined);
    assert.equal(small.body.toString(), '{"ok":false}');
    const stream = await get(`${base}/stream`, { 'Accept-Encoding': 'br' });
    assert.equal(stream.body.toString(), '{"a":1}\n{"b":2}\n');
    const written = await get(`${base}/written`, { 'Accept-Encoding': 'br' });
    assert.equal(written.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(written.body), big);
    const none = await get(`${base}/set`);
    assert.deepEqual(JSON.parse(none.body), big);
  });
});

test('every page carries the connection guard inline, and the offline notice is public', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD ||= 'isolated-connection-guard-test';
  const auth = require('../src/backend/services/auth_service');
  t.mock.method(auth, 'getAccountBySession', () => null);
  const router = require('../src/backend/routes/router');
  await serve((req, res) => router.handleRequest(req, res), async base => {
    for (const page of ['/admin/login', '/chat/login', '/offline.html']) {
      const res = await get(base + page);
      assert.equal(res.status, 200, page);
      const html = res.body.toString('utf8');
      const head = html.indexOf('<head>');
      assert.ok(head >= 0 && html.indexOf('window.KHConnection') > head, page);
      if (html.includes('<link')) assert.ok(html.indexOf('window.KHConnection') < html.indexOf('<link'), `${page}: guard runs before stylesheets`);
    }
    assert.match((await get(base + '/offline.html')).body.toString('utf8'), /KHConnection\.show\('offline'\)/);
  });
});

test('the injected guard is a single inline script that cannot close early', () => {
  const out = assets.injectConnectionGuard('<!doctype html><html><HEAD lang="vi"><title>x</title></HEAD><body></body></html>');
  assert.match(out, /<HEAD lang="vi"><script>\(\(\) => \{/);
  assert.equal((out.match(/<script>/g) || []).length, 1);
  assert.equal((out.match(/<\/script>/g) || []).length, 1);
});
