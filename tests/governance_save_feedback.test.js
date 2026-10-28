'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Minimal DOM: the drawer form, its controls and the status line.
async function setup() {
  const elements = new Map(), timers = new Map();
  function element() {
    return { value: '', dataset: {}, children: [], disabled: false, hidden: true, innerHTML: 'Lưu chính sách', textContent: '',
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      replaceChildren(...nodes) { this.children = nodes; }, append(node) { this.children.push(node); },
      querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, closest() { return this; }
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const form = get('governance-form'), button = element(), modeAll = { ...element(), value: 'all', checked: true }, aiLocal = { ...element(), value: 'local', checked: true };
  const inputs = [modeAll, aiLocal, element()];
  form.querySelector = () => button;
  form.querySelectorAll = () => [...inputs, button];
  let resolveSave, calls = 0, sent = null;
  const resource = { id: 'doc', name: 'Tài liệu A', type: 'document', revision: 1, functionGroups: [], inherited: false, legacy: false,
    policy: { revision: 1, access: { mode: 'all', users: [], denyUsers: [] }, aiSharing: { level: 'all', excludeDestinations: [] }, sql: { packages: [], hiddenTables: [] } } };
  const context = vm.createContext({
    window: {}, CSS: { escape: value => value },
    document: { getElementById: get, addEventListener() {}, createElement: element, querySelectorAll: () => [],
      querySelector: selector => selector.includes('dg-mode') ? modeAll : selector.includes('dg-ai') ? aiLocal : null },
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      if (options?.method === 'PUT') { calls++; sent = JSON.parse(options.body); return new Promise(resolve => { resolveSave = resolve; }); }
      return { ok: true, json: async () => ({ resources: [resource], providers: [], functionGroups: [], users: [], metrics: [] }) };
    }
  });
  vm.runInContext(fs.readFileSync('src/frontend/admin-client/js/modules/governance.js', 'utf8'), context);
  context.window.loadAgentOperations = context.window.loadGovernedMetrics = async () => {};
  await context.window.loadGovernanceResources();
  context.window.openGovernanceDrawer(0);
  return { get, form, button, inputs, timers, calls: () => calls, sent: () => sent,
    save: () => context.window.saveGovernanceResource({ preventDefault() {}, currentTarget: form }),
    respond: (ok, data) => resolveSave({ ok, json: async () => data }) };
}

test('policy save shows pending and slow feedback, prevents duplicate requests and confirms the saved revision', async () => {
  const app = await setup();
  const pending = app.save();
  assert.equal(app.get('governance-message').dataset.state, 'saving');
  assert.match(app.button.innerHTML, /Đang lưu/);
  assert.equal(app.form['aria-busy'], 'true');
  assert.ok(app.inputs[0].disabled);
  await app.save();
  assert.equal(app.calls(), 1);
  // The drawer sends a version 2 policy with the chosen AI sharing level.
  assert.equal(app.sent().policy.schemaVersion, 2); assert.equal(app.sent().policy.aiSharing.level, 'local');
  [...app.timers.values()][0]();
  assert.match(app.get('governance-message').textContent, /lâu hơn bình thường/);
  app.respond(true, { resource: { revision: 2, policy: { revision: 2, access: { mode: 'all', users: [], denyUsers: [] }, aiSharing: { level: 'local', excludeDestinations: [] }, sql: { packages: [], hiddenTables: [] } } } });
  await pending;
  assert.equal(app.get('governance-message').dataset.state, 'success');
  assert.match(app.get('governance-message').textContent, /Tài liệu A.*Phiên bản 2/);
  assert.equal(app.button.disabled, false);
  assert.equal(app.inputs[0].disabled, false);
  assert.equal(app.form['aria-busy'], undefined);
  assert.equal(app.timers.size, 0);
});

test('policy errors remain visible and preserve edits and pre-existing disabled fields for retry', async () => {
  const app = await setup();
  app.inputs[2].value = 'edited'; app.inputs[2].disabled = true;
  const pending = app.save();
  app.respond(false, { message: 'Phiên bản đã thay đổi.' });
  await pending;
  assert.equal(app.get('governance-message').dataset.state, 'error');
  assert.equal(app.get('governance-message').role, 'alert');
  assert.match(app.get('governance-message').textContent, /Phiên bản đã thay đổi/);
  assert.equal(app.inputs[2].value, 'edited');
  assert.equal(app.inputs[2].disabled, true);
  assert.equal(app.button.disabled, false);
  assert.equal(app.timers.size, 0);
});
