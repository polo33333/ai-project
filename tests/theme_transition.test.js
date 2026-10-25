'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../src/frontend/shared/js/theme.js'), 'utf8');

function setup({ reduced = false, native = true } = {}) {
  const events = {}, media = {}, classes = new Set(), timers = [];
  let transitions = 0, skipped = 0;
  const root = { dataset: {}, classList: { add: x => classes.add(x), remove: x => classes.delete(x) }, offsetWidth: 100 };
  const document = {
    documentElement: root, head: { appendChild() {} }, createElement: () => ({}),
    querySelectorAll: () => [], addEventListener: (name, cb) => { events[name] = cb; }
  };
  if (native) document.startViewTransition = cb => {
    transitions++;
    cb();
    return { finished: Promise.resolve(), skipTransition() { skipped++; } };
  };
  const window = { addEventListener: (name, cb) => { events[name] = cb; } };
  vm.runInNewContext(source, {
    document, window, localStorage: { getItem: () => 'light', setItem() {} },
    matchMedia: query => ({ matches: query.includes('reduced-motion') ? reduced : false, addEventListener: (name, cb) => { media[query] = cb; } }),
    setTimeout: cb => timers.push(cb), clearTimeout() {}
  });
  const choose = value => events.click({ target: { closest: selector => selector === '[data-theme-choice]' ? { dataset: { themeChoice: value } } : null } });
  return { root, classes, timers, events, media, choose, transitions: () => transitions, skipped: () => skipped };
}

test('theme loads immediately and cross-fades subsequent choices, including rapid changes', async () => {
  const app = setup();
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.transitions(), 0);
  app.choose('dark');
  assert.equal(app.root.dataset.theme, 'dark');
  app.choose('light');
  assert.equal(app.root.dataset.theme, 'light');
  assert.equal(app.transitions(), 2);
  assert.equal(app.skipped(), 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.classes.size, 0);
});

test('reduced motion skips the transition', () => {
  const app = setup({ reduced: true });
  app.choose('dark');
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.transitions(), 0);
  assert.equal(app.classes.size, 0);
});

test('older browsers animate colors and clean up; system and cross-tab changes use the same path', () => {
  const app = setup({ native: false });
  app.choose('dark');
  assert.ok(app.classes.has('kh-theme-colors'));
  app.timers.at(-1)();
  assert.equal(app.classes.size, 0);
  app.choose('auto');
  assert.equal(app.root.dataset.theme, 'light');
  app.events.storage({ key: 'knowledgehub.theme', newValue: 'dark' });
  assert.equal(app.root.dataset.theme, 'dark');
  app.events.storage({ key: 'knowledgehub.theme', newValue: 'auto' });
  app.media['(prefers-color-scheme: dark)']();
  assert.equal(app.root.dataset.theme, 'light');
});
