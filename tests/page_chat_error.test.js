'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('chat displays backend failure in an assistant bubble and releases composer', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/page_chat.js'), 'utf8');
  const body = source.slice(source.indexOf('async function sendPageChatMessage()'), source.indexOf('async function populateChatKnowledgeSources()'));
  const messages = [];
  const node = () => ({ style: {}, innerHTML: '', get outerHTML() { return this.innerHTML; }, remove() {} });
  const container = { appendChild() {}, scrollHeight: 0 };
  const input = { value: 'thông tin chi tiết nv' };
  const window = { pageChatAttachments: [], aiPersona: { name: 'KAI', role: 'Copilot' }, updatePageChatMiniPanel() {} };
  const noop = () => {};
  const sandbox = {
    window, AbortController, chatHistoryReady: Promise.resolve(), chatHistoryFailed: false,
    document: { getElementById: id => id === 'page-chat-user-input' ? input : id === 'page-chat-messages-container' ? container : null, createElement: node },
    getCurrentChatSession: () => ({ id: 'conversation', history: [] }),
    updatePageChatCharacterCount: noop, renderPageChatAttachments: noop,
    escapeChatMarkdown: value => value, appendChatMessage: message => messages.push(message),
    createThinkingBubble: node, disposeThinkingBubble: noop,
    setPageChatResponding: value => { window.pageChatIsResponding = value; },
    getChatKnowledgeValues: () => ['none'], buildPageChatAttachmentContext: async () => '',
    fetchStreamingChat: async () => { throw new Error('ROUTING_TIMEOUT'); }
  };
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  await sandbox.sendPageChatMessage();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].html, /ROUTING_TIMEOUT/);
  assert.match(messages[1].html, /KAI/);
  assert.equal(window.pageChatIsResponding, false);
});
