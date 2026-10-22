'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('thinking status types progressively, replaces old labels and cancels on removal', () => {
  const timers = new Map(); let id = 0;
  const current = { textContent: '' };
  const root = { _reasoningRecords: new Map(), querySelector: () => current, remove() {} };
  const context = vm.createContext({ window: {}, document: {}, setInterval(fn) { timers.set(++id, fn); return id; }, clearInterval(key) { timers.delete(key); } });
  vm.runInContext(fs.readFileSync('src/frontend/js/chat_reasoning_ui.js', 'utf8'), context);
  const ui = context.window.ChatReasoningUI;
  ui.update(root, {}, 'Đang tìm bảng và cột phù hợp');
  assert.equal(current.textContent, 'Đa');
  const timer = root._statusTypingTimer;
  ui.update(root, {}, 'Đang tìm bảng và cột phù hợp');
  assert.equal(root._statusTypingTimer, timer);
  timers.get(timer)();
  assert.equal(current.textContent, 'Đang');
  ui.update(root, {}, 'Đang truy vấn dữ liệu');
  assert.ok(!timers.has(timer));
  for (let i = 0; i < 30; i++) [...timers.values()].forEach(fn => fn());
  assert.equal(current.textContent, 'Đang truy vấn dữ liệu');
  assert.equal(timers.size, 0);
  ui.update(root, {}, 'Đang tổng hợp kết quả');
  root.remove();
  assert.equal(timers.size, 0);
});

test('thinking status respects reduced motion and hidden tabs', () => {
  for (const hidden of [false, true]) {
    const current = { textContent: '' };
    const root = { querySelector: () => current };
    const context = vm.createContext({ window: { matchMedia: () => ({ matches: !hidden }) }, document: { hidden }, clearInterval() {}, setInterval() { throw new Error('must not animate'); } });
    vm.runInContext(fs.readFileSync('src/frontend/js/chat_reasoning_ui.js', 'utf8'), context);
    context.window.ChatReasoningUI.update(root, {}, 'Đang tìm bảng');
    assert.equal(current.textContent, 'Đang tìm bảng');
  }
});
