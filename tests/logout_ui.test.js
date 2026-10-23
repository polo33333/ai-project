'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs');
const source = fs.readFileSync('src/frontend/js/app.js', 'utf8');

function fixture(fetch) {
  const confirm = { disabled: false, innerHTML: 'Xác nhận', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } };
  const cancel = { disabled: false }, error = { textContent: '' };
  const modal = { querySelectorAll: () => [confirm, cancel], classList: { remove() { modal.closed = true; } }, setAttribute() {} };
  const nodes = { 'logout-confirm-btn': confirm, 'logout-confirm-modal': modal, 'logout-error': error };
  const timers = new Map(), navigations = [], removed = [];
  let nextTimer = 0;
  const context = vm.createContext({
    AbortController, fetch, MAIN_TAB_STORAGE_KEY: 'active-tab',
    document: { getElementById: id => nodes[id] },
    localStorage: { removeItem: key => removed.push(key) },
    window: { setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
      clearTimeout(id) { timers.delete(id); }, location: { replace: path => navigations.push(path) } }
  });
  vm.runInContext('let logoutInProgress = false;\n' + source.slice(source.indexOf('function closeLogoutConfirmation()'), source.indexOf('const featureSearchItems')), context);
  return { context, confirm, cancel, error, modal, timers, navigations, removed };
}

test('logout responds immediately, blocks duplicate requests and navigates only after server revocation succeeds', async () => {
  let complete, calls = 0;
  const f = fixture(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const pending = f.context.performLogout();
  assert.equal(f.confirm.disabled, true); assert.equal(f.cancel.disabled, true);
  assert.equal(f.confirm.attributes['aria-busy'], 'true');
  await f.context.performLogout(); assert.equal(calls, 1);
  f.context.closeLogoutConfirmation(); assert.equal(f.modal.closed, undefined);
  assert.deepEqual(f.navigations, []); assert.deepEqual(f.removed, []);
  complete({ ok: true }); await pending;
  assert.deepEqual(f.navigations, ['/login']); assert.deepEqual(f.removed, ['active-tab']);
  assert.equal(f.timers.size, 0);
});

test('logout server/network failures keep the user on the page and allow a successful retry', async () => {
  for (const failure of ['server', 'network']) {
    let calls = 0;
    const f = fixture(async () => {
      if (++calls > 1) return { ok: true };
      if (failure === 'network') throw new TypeError('offline');
      return { ok: false, status: 503 };
    });
    await f.context.performLogout();
    assert.deepEqual(f.navigations, []); assert.deepEqual(f.removed, []);
    assert.match(f.error.textContent, /Chưa thể đăng xuất/);
    assert.equal(f.confirm.disabled, false); assert.equal(f.cancel.disabled, false);
    assert.equal(f.confirm.innerHTML, 'Xác nhận'); assert.equal(f.timers.size, 0);
    await f.context.performLogout(); assert.equal(calls, 2);
    assert.deepEqual(f.navigations, ['/login']); assert.equal(f.error.textContent, '');
  }
});

test('a stalled logout times out and restores the confirmation controls', async () => {
  const f = fixture((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })));
  }));
  const pending = f.context.performLogout();
  const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 8000);
  timer.callback(); await pending;
  assert.match(f.error.textContent, /phản hồi chậm/); assert.deepEqual(f.navigations, []);
  assert.equal(f.confirm.disabled, false); assert.equal(f.timers.size, 0);
});
