'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');

test('unpin waits for persistence, prevents duplicate clicks and restores state on failure', async () => {
  for (const success of [false, true]) {
    const session = { id: 'chat-one', pinned: true, pinnedAt: 100 };
    const notices = [];
    let finish, saves = 0;
    const context = vm.createContext({ window: { chatSessions: [session] }, chatHistoryLoaded: true, chatHistoryFailed: false,
      chatPinSaves: new Set(), saveChatSessions: () => { saves++; return new Promise(resolve => { finish = resolve; }); },
      renderChatSessionsList() {}, showToast: (...args) => notices.push(args) });
    vm.runInContext(source.slice(source.indexOf('async function togglePinChatSession('), source.indexOf('async function renameChatSession(')), context);
    const pending = context.togglePinChatSession('chat-one');
    await context.togglePinChatSession('chat-one');
    assert.equal(saves, 1);
    assert.equal(notices.length, 0);
    finish(success); await pending;
    assert.equal(session.pinned, !success);
    assert.equal(notices.length, success ? 1 : 0);
    if (!success) assert.equal(session.pinnedAt, 100);
  }
});

test('failed history save uses a separate notice and retry retains messages', async () => {
  const nodes = Object.fromEntries(['chat-history-save-notice', 'chat-history-save-message', 'chat-history-save-retry'].map(id => [id, { hidden: true, disabled: false, setAttribute(name) { if (name === 'hidden') this.hidden = true; } }]));
  let requests = 0;
  const notices = [];
  const session = { id: 'chat-one', title: 'Hello', messages: [{ html: 'Keep this' }], history: [] };
  const context = vm.createContext({ window: { chatSessions: [session] }, localStorage: { setItem() {} }, CHAT_ACTIVE_SESSION_KEY: 'active',
    document: { getElementById: id => nodes[id] }, showToast: (...args) => notices.push(args), console: { error() {} },
    fetch: async () => ++requests === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ versions: { 'chat-one': 1 } }) } });
  vm.runInContext(source.slice(source.indexOf('let chatHistoryLoaded ='), source.indexOf('function clearBackendConversationMemory(')) + '\nchatHistoryLoaded=true;', context);
  assert.equal(await context.saveChatSessions(), false);
  assert.equal(nodes['chat-history-save-notice'].hidden, false);
  await context.retrySaveChatSessions();
  assert.equal(nodes['chat-history-save-notice'].hidden, true);
  assert.equal(session.messages[0].html, 'Keep this');
  assert.equal(requests, 2);
  assert.equal(notices.at(-1)[1], 'success');
});

test('a network failure identifies the history save and retains the unsaved answer for retry',async()=>{
 const nodes=Object.fromEntries(['chat-history-save-notice','chat-history-save-message','chat-history-save-retry'].map(id=>[id,{hidden:true}]));
 const notices=[],session={id:'chat-one',messages:[{role:'assistant',html:'Completed answer'}],history:[]};
 const context=vm.createContext({window:{chatSessions:[session]},localStorage:{setItem(){}},CHAT_ACTIVE_SESSION_KEY:'active',
  document:{getElementById:id=>nodes[id]},showToast:(...args)=>notices.push(args),console:{error(){}},fetch:async()=>{throw new TypeError('Failed to fetch');}});
 vm.runInContext(source.slice(source.indexOf('let chatHistoryLoaded ='),source.indexOf('function clearBackendConversationMemory('))+'\nchatHistoryLoaded=true;',context);
 assert.equal(await context.saveChatSessions(),false);
 assert.equal(session.messages[0].html,'Completed answer');
 assert.equal(notices[0][2],'Chưa lưu được lịch sử');
 assert.ok(!notices[0][0].includes('Failed to fetch'));
 assert.equal(nodes['chat-history-save-notice'].hidden,false);assert.equal(nodes['chat-history-save-retry'].hidden,false);
});
