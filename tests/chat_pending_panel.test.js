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
    appendChatMessage: record => children.push(record)
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
