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
  vm.runInContext(fs.readFileSync('src/frontend/shared/js/chat_reasoning_ui.js', 'utf8'), context);
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
    vm.runInContext(fs.readFileSync('src/frontend/shared/js/chat_reasoning_ui.js', 'utf8'), context);
    context.window.ChatReasoningUI.update(root, {}, 'Đang tìm bảng');
    assert.equal(current.textContent, 'Đang tìm bảng');
  }
});

test('status keeps updating after reasoning text is shown', () => {
  const current = { textContent: 'Đang chuẩn bị câu trả lời…' };
  const content = { hidden: true, appendChild() {} };
  const root = { querySelector: selector => selector === '.chat-thinking-copy span' ? current : selector === '.chat-thinking-steps' ? content : null };
  const context = vm.createContext({ window: { matchMedia: () => ({ matches: true }) }, document: { hidden: false, createElement: () => ({ textContent: '' }) },
    setInterval: () => 1, clearInterval() {} });
  vm.runInContext(fs.readFileSync('src/frontend/shared/js/chat_reasoning_ui.js', 'utf8'), context);
  const ui = context.window.ChatReasoningUI;
  ui.update(root, { type: 'reasoning_delta', delta: 'Người dùng hỏi hợp đồng' });
  assert.equal(current.textContent, '');
  ui.update(root, { type: 'workflow_assessment' }, 'Đang kiểm tra quy trình có khớp câu hỏi');
  assert.equal(current.textContent, 'Đang kiểm tra quy trình có khớp câu hỏi');
  ui.update(root, { type: 'reasoning_delta', delta: ' theo mã' });
  assert.equal(current.textContent, 'Đang kiểm tra quy trình có khớp câu hỏi');
});
