'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function setup() {
  const elements = new Map(), timers = new Map();
  function element() {
    return { value: '', dataset: {}, children: [], disabled: false, innerHTML: 'Lưu chính sách',
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      replaceChildren(...nodes) { this.children = nodes; }, append(node) { this.children.push(node); },
      closest() { return this; }
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const form = get('governance-form'), button = element();
  const inputs = ['visibility', 'sensitivity', 'subjects', 'roles', 'embedIds', 'modelDestinations', 'allowedTables', 'blockedColumns'].map(id => get('governance-' + id));
  form.querySelector = () => button;
  form.querySelectorAll = () => [...inputs, button];
  get('governance-resource').value = '0';
  let resolveSave, calls = 0;
  const context = vm.createContext({
    window: {}, document: { getElementById: get, querySelectorAll: () => [], createElement: element },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      if (options?.method === 'PUT') { calls++; return new Promise(resolve => { resolveSave = resolve; }); }
      return { ok: true, json: async () => ({ resources: [{ id: 'doc', name: 'Tài liệu A', type: 'document', policy: { revision: 1, visibility: 'shared', sensitivity: 'internal' } }], providers: [] }) };
    }
  });
  vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance.js', 'utf8'), context);
  context.window.loadAgentOperations = context.window.loadGovernedMetrics = async () => {};
  await context.window.loadGovernanceResources();
  return { get, form, button, inputs, timers, calls: () => calls,
    save: () => context.window.saveGovernanceResource({ preventDefault() {}, currentTarget: form }),
    respond: (ok, data) => resolveSave({ ok, json: async () => data }) };
}

test('policy save shows pending and slow feedback, prevents duplicate requests and confirms the saved revision', async () => {
  const app = await setup();
  const pending = app.save();
  assert.equal(app.get('governance-message').dataset.state, 'saving');
  assert.match(app.button.innerHTML, /Đang lưu/);
  assert.equal(app.form['aria-busy'], 'true');
  assert.ok(app.get('governance-resource').disabled);
  await app.save();
  assert.equal(app.calls(), 1);
  [...app.timers.values()][0]();
  assert.match(app.get('governance-message').textContent, /lâu hơn bình thường/);
  app.respond(true, { resource: { policy: { revision: 2 } } });
  await pending;
  assert.equal(app.get('governance-message').dataset.state, 'success');
  assert.match(app.get('governance-message').textContent, /Tài liệu A.*Phiên bản 2/);
  assert.equal(app.button.disabled, false);
  assert.equal(app.get('governance-resource').disabled, false);
  assert.equal(app.form['aria-busy'], undefined);
  assert.equal(app.timers.size, 0);
});

test('policy errors remain visible and preserve edits and pre-existing disabled fields for retry', async () => {
  const app = await setup();
  app.get('governance-roles').value = 'admin';
  app.get('governance-blockedColumns').disabled = true;
  const pending = app.save();
  app.respond(false, { message: 'Phiên bản đã thay đổi.' });
  await pending;
  assert.equal(app.get('governance-message').dataset.state, 'error');
  assert.equal(app.get('governance-message').role, 'alert');
  assert.match(app.get('governance-message').textContent, /Phiên bản đã thay đổi/);
  assert.equal(app.get('governance-roles').value, 'admin');
  assert.equal(app.get('governance-blockedColumns').disabled, true);
  assert.equal(app.button.disabled, false);
  assert.equal(app.timers.size, 0);
});
