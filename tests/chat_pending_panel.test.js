'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/frontend/js/modules/page_chat.js'), 'utf8');
function extract(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`\n${next}`, source.indexOf(`function ${name}(`)));
}

test('returning to the request session restores the same pending panel after history rendering', () => {
  const node = { id: 'thinking-test' };
  const children = [];
  const container = { set innerHTML(value) { children.length = 0; }, appendChild(value) { children.push(value); }, scrollHeight: 10 };
  let session = { id: 'owner', messages: [{ role: 'user' }] };
  const context = vm.createContext({
    window: { pageChatPendingThinking: { sessionId: 'owner', node } },
    document: { getElementById: () => container },
    getCurrentChatSession: () => session,
    appendChatMessage: record => children.push(record),
    saveChatSessions: () => {}
  });
  vm.runInContext(extract('renderCurrentChatMessages', 'async function submitChatFeedback'), context);
  vm.runInContext('renderCurrentChatMessages()', context);
  assert.equal(children.at(-1), node);
  vm.runInContext('renderCurrentChatMessages()', context);
  assert.equal(children.filter(child => child === node).length, 1);
  session = { id: 'other', messages: [] };
  vm.runInContext('renderCurrentChatMessages()', context);
  assert.equal(children.length, 0);
});

test('progress updates reach the retained panel while the chat DOM is detached', () => {
  const steps = [];
  const label = {};
  const node = { id: 'thinking-test', querySelector: selector => selector === '.chat-thinking-steps' ? { appendChild: step => steps.push(step) } : label };
  const context = vm.createContext({
    window: { pageChatPendingThinking: { node } },
    performance: { now: () => 100 },
    document: { getElementById: () => null, createElement: () => ({ dataset: {} }) },
    typeThinkingText: (element, value) => { element.textContent = value; },
    escapeChatMarkdown: value => value
  });
  vm.runInContext(extract('addThinkingStep', 'function finalizeThinkingBubble'), context);
  vm.runInContext("addThinkingStep('thinking-test', 'spinner', 'Đang truy vấn', 'running')", context);
  assert.equal(label.textContent, 'Đang truy vấn');
  assert.equal(steps.length, 1);
});

test('reasoning updates the current label without expanding the retained details', () => {
  function element() { return { dataset: {}, children: [], textContent: '', appendChild(child) { this.children.push(child); }, querySelector(tag) { return this.children.find(child => child.tag === tag); } }; }
  const steps = element();
  steps.hidden = true;
  const current = {};
  const node = { id: 'thinking-test', querySelector: selector => selector === '.chat-thinking-steps' ? steps : current };
  const updates = [];
  const context = vm.createContext({ typeThinkingText: (element, text, key) => updates.push({ element, text, key }), window: { pageChatPendingThinking: { node } }, document: {
    getElementById: () => null, createElement: tag => Object.assign(element(), { tag })
  } });
  vm.runInContext(extract('addThinkingStep', 'function finalizeThinkingBubble'), context);
  vm.runInContext(`addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, delta: '<script>' });
    addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, delta: 'text' });`, context);
  assert.equal(steps.children.length, 1);
  assert.equal(steps.children[0].querySelector('pre').textContent, '<script>text');
  assert.equal(steps.hidden, true);
  assert.equal(steps.children[0].open, false);
  assert.equal(updates.at(-1).element, current);
  assert.equal(updates.at(-1).text, '<script>text');
  vm.runInContext(`addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, reasoningId: 'routing:1', delta: 'Routing summary' });
    addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, reasoningId: 'workflow:explanation', delta: 'Explanation summary' });`, context);
  assert.equal(steps.children.length, 3);
  assert.equal(steps.children[1].querySelector('pre').textContent, 'Routing summary');
  assert.equal(steps.children[2].querySelector('pre').textContent, 'Explanation summary');
});

test('streamed current text continues typing across deltas and resets for the next stage', () => {
  const timers = new Map();
  let nextId = 0;
  const element = { textContent: '', scrollWidth: 100 };
  const context = vm.createContext({ element,
    setInterval: callback => { timers.set(++nextId, callback); return nextId; },
    clearInterval: id => timers.delete(id)
  });
  vm.runInContext(extract('typeThinkingText', 'function addThinkingStep'), context);
  vm.runInContext("typeThinkingText(element, '**Reviewing** the task', 'routing:1')", context);
  for (let i = 0; i < 6; i++) for (const callback of timers.values()) callback();
  const prefix = element.textContent;
  assert.ok(prefix.length > 0);
  vm.runInContext("typeThinkingText(element, '**Reviewing** the task carefully', 'routing:1')", context);
  assert.equal(element.textContent, prefix);
  assert.equal(timers.size, 1);
  for (let i = 0; i < 100; i++) for (const callback of timers.values()) callback();
  assert.equal(element.textContent, 'Reviewing the task carefully');
  assert.equal(timers.size, 0);
  vm.runInContext("typeThinkingText(element, 'Checking metadata', 'workflow:explanation')", context);
  assert.equal(element.textContent, '');
  for (let i = 0; i < 100; i++) for (const callback of timers.values()) callback();
  assert.equal(element.textContent, 'Checking metadata');
});
