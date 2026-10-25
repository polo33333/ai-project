const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/frontend/shared/js/modules/page_chat.js'), 'utf8');
test('history sync merges remote changes, retains selection and expanded pages, and skips unsaved or running chats', async () => {
  let requests = 0, rendered = 0;
  const unchanged = {id:'a',version:1,messages:['expanded'],title:'A'};
  const changed = {id:'b',version:1,messages:[],title:'B'};
  const snapshot = ({version,...rest}) => JSON.stringify(rest);
  const context = vm.createContext({
    window:{chatSessions:[unchanged,changed],currentChatSessionId:'a',addEventListener(){}},
    document:{hidden:false,addEventListener(){}},setInterval(){},chatHistoryLoaded:true,chatHistoryFailed:false,
    chatPageLoads:new Set(),persistedChatSessions:new Map([unchanged,changed].map(s=>[s.id,{version:s.version,snapshot:snapshot(s)}])),
    sessionSnapshot:snapshot,normalizeStoredChatSession:s=>s,chatPayloadBytes:()=>0,
    renderChatSessionsList(){rendered++;},renderCurrentChatMessages(){throw Error('unchanged selection must not rerender');},loadPageChatSessionFiles(){},
    fetch:async()=>{requests++;return {ok:true,json:async()=>({sessions:[{id:'a',version:1,messages:[]},{id:'b',version:2,title:'Updated',messages:[]},{id:'c',version:1,title:'New',messages:[]}]})};}
  });
  vm.runInContext(source.slice(source.indexOf('let chatHistorySyncing'),source.indexOf('// Load persona from server')),context);
  await context.syncChatSessions();
  assert.equal(context.window.chatSessions[0],unchanged);
  assert.equal(context.window.chatSessions[1].title,'Updated');
  assert.equal(context.window.chatSessions.length,3);
  assert.equal(context.window.currentChatSessionId,'a');
  assert.equal(rendered,1);
  context.window.pageChatIsResponding=true;
  await context.syncChatSessions();
  context.window.pageChatIsResponding=false;
  unchanged.title='Unsaved';
  await context.syncChatSessions();
  assert.equal(requests,1);
});
