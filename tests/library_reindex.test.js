'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const library = require('../src/backend/knowledge_core/services/library_service');
const routes = require('../src/backend/knowledge_core/routes/document_routes');

function response() {
  return { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
}

for (const queued of [false, true]) {
  test(`reindex endpoint reports ${queued ? 'queued work' : 'completed work and individual failures'}`, async t => {
    const summary = queued ? { total: 2, indexed: 0, queued: 2, failed: [] }
      : { total: 2, indexed: 1, failed: [{ id: 'b', error: 'Missing original file' }] };
    t.mock.method(library, 'reindexAll', async () => summary);
    t.mock.method(library, 'getDocuments', () => [{ id: 'a', status: queued ? 'Đang xử lý' : 'Đã lập chỉ mục' }]);
    const res = response();
    assert.equal(await routes.handle({ method: 'POST' }, res, '/api/library/reindex', {}), true);
    assert.equal(res.code, queued ? 202 : 200);
    assert.equal(res.body.status, queued ? 'queued' : 'completed');
    assert.deepEqual(res.body.summary, summary);
    assert.equal(res.body.documents[0].id, 'a');
  });
}

test('overlapping reindex requests are rejected and a failed run can be retried', async t => {
  let reject;
  t.mock.method(library, 'reindexAll', () => new Promise((_, no) => { reject = no; }));
  const first = response(), second = response();
  const running = routes.handle({ method: 'POST' }, first, '/api/library/reindex', {});
  await routes.handle({ method: 'POST' }, second, '/api/library/reindex', {});
  assert.equal(second.code, 409);
  reject(new Error('Index unavailable'));
  await running;
  assert.equal(first.code, 500);
  t.mock.method(library, 'reindexAll', async () => ({ total: 0, indexed: 0, failed: [] }));
  t.mock.method(library, 'getDocuments', () => []);
  const retry = response();
  await routes.handle({ method: 'POST' }, retry, '/api/library/reindex', {});
  assert.equal(retry.code, 200);
});

function ui(fetch) {
  const elements = { 'library-reindex-btn': { setAttribute() {} }, 'library-reindex-status': {}, 'view-library': { style: { display: 'grid' } } };
  const timers = [];
  const context = { window: {}, localStorage: { getItem() {} }, document: { getElementById: id => elements[id] },
    clearTimeout() {}, setTimeout: fn => { timers.push(fn); return timers.length; }, fetch, showToast() {}, showUiConfirm: async () => true };
  vm.createContext(context);
  const source = fs.readFileSync('src/frontend/js/modules/library.js', 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('function escapeLibraryHtml')), context);
  context.renderLibraryDocuments = () => {};
  context.window.libraryDocuments = [{ id: 'a', status: 'Đã lập chỉ mục' }];
  return { context, elements, timers };
}

test('UI prevents duplicate clicks, shows errors and allows retry', async () => {
  let reject, calls = 0;
  const { context, elements } = ui(() => { calls++; return new Promise((_, no) => { reject = no; }); });
  const first = context.reindexLibraryDocuments();
  await context.reindexLibraryDocuments();
  assert.equal(calls, 1);
  assert.equal(elements['library-reindex-btn'].disabled, true);
  reject(new Error('Offline'));
  await first;
  assert.equal(elements['library-reindex-btn'].disabled, false);
  assert.equal(elements['library-reindex-status'].textContent, 'Offline');
});

test('queued UI work polls document status and releases the button after completion', async () => {
  const { context, elements, timers } = ui(async () => ({ ok: true, json: async () => ({ status: 'queued', documents: [{ id: 'a', status: 'Đang xử lý' }] }) }));
  await context.reindexLibraryDocuments();
  assert.equal(elements['library-reindex-btn'].disabled, true);
  assert.ok(timers.length > 0);
  context.window.libraryDocuments = [{ id: 'a', status: 'Đã lập chỉ mục' }];
  context.updateLibraryReindexState();
  assert.equal(elements['library-reindex-btn'].disabled, false);
  assert.match(elements['library-reindex-status'].textContent, /1\/1/);
});

test('reindex waits for confirmation, ignores repeated clicks and sends nothing when cancelled', async () => {
  let calls = 0, dialogs = 0, confirm;
  const { context, elements } = ui(() => { calls++; throw new Error('Must not send before approval'); });
  context.showUiConfirm = (message, options) => {
    dialogs++;
    assert.match(message, /toàn bộ 1 tài liệu/);
    assert.equal(options.confirmText, 'Tái lập chỉ mục');
    return new Promise(resolve => { confirm = resolve; });
  };
  const first = context.reindexLibraryDocuments();
  await context.reindexLibraryDocuments();
  assert.equal(dialogs, 1);
  assert.equal(calls, 0);
  confirm(false);
  await first;
  assert.equal(calls, 0);
  assert.equal(elements['library-reindex-status'].textContent, undefined);
  const retry = context.reindexLibraryDocuments();
  assert.equal(dialogs, 2);
  confirm(false);
  await retry;
});
