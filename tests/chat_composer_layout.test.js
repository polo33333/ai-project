'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('floating composer clearance follows size changes without moving a reader who scrolled up', () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const code = source.slice(source.indexOf('window.syncPageChatComposerLayout ='), source.indexOf('window.syncPageChatScrollActivity='));
  let height = 90, resize, observed = 0, clearance;
  const messages = { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 };
  const main = { style: { setProperty(name, value) {
    assert.equal(name, '--page-chat-composer-height');
    clearance = value;
    messages.scrollHeight += 100;
  } } };
  const area = { parentElement: main, getBoundingClientRect: () => ({ height }) };
  const context = { window: { ResizeObserver: class {
    constructor(callback) { resize = callback; }
    observe(node) { assert.equal(node, area); observed++; }
  } }, document: { querySelector: () => area, getElementById: () => messages } };
  vm.runInNewContext(code, context);
  context.window.syncPageChatComposerLayout();
  assert.equal(clearance, '90px');
  assert.equal(messages.scrollTop, 1100);
  context.window.syncPageChatComposerLayout();
  assert.equal(observed, 1);
  messages.scrollTop = 100;
  height = 170;
  resize();
  assert.equal(clearance, '170px');
  assert.equal(messages.scrollTop, 100);
  height = 0; // Hidden SPA tab must retain the last usable clearance.
  resize();
  assert.equal(clearance, '170px');
});
