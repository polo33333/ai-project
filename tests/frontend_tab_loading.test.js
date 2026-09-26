const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../src/frontend/js', file), 'utf8');

test('table loading coalesces requests and clears busy state after failure', async () => {
  let reject, calls = 0;
  const classes = new Set();
  const attributes = new Map();
  const panel = {
    classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    appendChild: node => { panel.overlay = node; }, closest: () => panel
  };
  const window = { fetchChatHistory: () => { calls++; return new Promise((_, no) => { reject = no; }); } };
  vm.runInNewContext(read('tab_loading.js'), { window, document: {
    querySelectorAll: selector => selector === '#chat-history-tbody' ? [panel] : [],
    createElement: () => ({ setAttribute() {}, remove() { panel.overlay = null; } })
  } });
  const first = window.fetchChatHistory();
  assert.equal(first, window.fetchChatHistory());
  assert.equal(attributes.get('aria-busy'), 'true');
  await Promise.resolve();
  assert.equal(calls, 1);
  reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(panel.overlay, null);
  const retry = window.fetchChatHistory();
  await Promise.resolve();
  assert.equal(calls, 2);
  reject(new Error('offline'));
  await assert.rejects(retry);
});

test('tab cache keeps separate loaders, coalesces and retries failures', async () => {
  const source = read('app.js');
  const start = source.indexOf('const TAB_DATA_CACHE_TTL_MS');
  const end = source.indexOf('function normalizeMainTabKey', start);
  const context = { window: {}, normalizeMainTabKey: key => key, Date, Map, Promise };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  let calls = 0;
  const loader = async () => { calls++; };
  await Promise.all([context.loadTabData('chat', [loader]), context.loadTabData('chat', [loader])]);
  await context.loadTabData('chat', [loader]);
  assert.equal(calls, 1);
  await context.loadTabData('chat', [async () => { calls++; }]);
  assert.equal(calls, 2);
  context.window.invalidateMainTabData('chat');
  await context.loadTabData('chat', [loader]);
  assert.equal(calls, 3);
  let attempts = 0;
  const failing = async () => { if (++attempts === 1) throw new Error('offline'); };
  await assert.rejects(context.loadTabData('chat', [failing]));
  await context.loadTabData('chat', [failing]);
  assert.equal(attempts, 2);
});

test('concurrent view navigation fetches and inserts the HTML once', async () => {
  const source = read('app.js');
  const start = source.indexOf('const viewLoadPromises');
  const end = source.indexOf('// Fetch Qdrant Status', start);
  let calls = 0, inserts = 0, resolve;
  const container = { querySelector: () => null, appendChild: () => { inserts++; } };
  const context = { Map, console, document: {
    getElementById: () => container,
    createElement: () => ({ content: { firstElementChild: { dataset: {} } } })
  }, fetch: () => { calls++; return new Promise(done => { resolve = done; }); } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const first = context.loadViewComponents('sql');
  const second = context.loadViewComponents('sql_connector');
  assert.equal(calls, 1);
  resolve({ ok: true, text: async () => '<div></div>' });
  await Promise.all([first, second]);
  assert.equal(inserts, 1);
});
