'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/frontend/js/modules/page_chat.js'), 'utf8');

test('time markers group continuous messages and separate long gaps or a new day', () => {
  const sandbox = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function shouldShowChatTimeMarker('), source.indexOf('function appendChatMessage(')), sandbox);
  const start = new Date(2026,9,20,10,0).getTime();
  assert.equal(sandbox.shouldShowChatTimeMarker(null,start),true);
  assert.equal(sandbox.shouldShowChatTimeMarker(start,start+14*60*1000),false);
  assert.equal(sandbox.shouldShowChatTimeMarker(start,start+15*60*1000),true);
  assert.equal(sandbox.shouldShowChatTimeMarker(new Date(2026,9,20,23,59).getTime(),new Date(2026,9,21,0,1).getTime()),true);
});

test('switching sessions remains available during a response and restores the selected history', () => {
  const window = { pageChatIsResponding: true, currentChatSessionId: 'a', chatSessions: [{ id: 'a' }, { id: 'b', title: 'B' }] };
  let rendered = null;
  const sandbox = { window, CHAT_ACTIVE_SESSION_KEY: 'active', localStorage: { setItem() {} }, document: { getElementById: () => null },
    normalizeStoredChatSession() {}, renderCurrentChatMessages() { rendered = window.currentChatSessionId; }, renderChatSessionsList() {} };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function selectChatSession('), source.indexOf('async function clearAllChatSessions(')), sandbox);
  sandbox.selectChatSession('b');
  assert.equal(rendered, 'b');
  assert.equal(window.pageChatIsResponding, true);
});

test('background replies and errors persist only to their owning session without touching visible DOM', () => {
  const a = { id: 'a', messages: [] }, b = { id: 'b', messages: [] };
  let saves = 0;
  const sandbox = { window: { currentChatSessionId: 'b', chatSessions: [a, b] }, saveChatSessions() { saves++; },
    document: { getElementById() { throw new Error('Background answer must not touch current DOM'); } } };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(source.indexOf('function appendChatMessage('), source.indexOf('function renderCurrentChatMessages(')), sandbox);
  const reply = { role: 'assistant', html: 'answer', chartId: 'chart-a', chartSpec: { type: 'bar' } };
  sandbox.appendChatMessage(reply, true, true, a);
  sandbox.appendChatMessage({ role: 'assistant', html: 'error' }, true, true, a);
  assert.equal(a.messages.length, 2);
  assert.equal(a.messages[0], reply);
  assert.equal(b.messages.length, 0);
  assert.equal(saves, 2);
  sandbox.window.chatSessions = [b];
  sandbox.appendChatMessage({ role: 'assistant', html: 'late reply' }, true, true, a);
  assert.equal(a.messages.length, 2);
  assert.equal(saves, 2);
});
