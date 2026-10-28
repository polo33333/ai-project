'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('src/backend/services/page_chat_history_service.js','utf8');
test('continuation API operation includes model configuration without loading unrelated chat history',()=> {
  const {requestStores}=require('../src/backend/storage/request_stores');
  const files=requestStores({method:'POST',url:'/api/page-chat/sessions'});
  assert.ok(files.includes('ai_providers.json'));
  assert.ok(!files.includes('chat_history.json'));
  assert.ok(!requestStores({method:'GET',url:'/api/page-chat/sessions'}).includes('ai_providers.json'));
});
function fixture(options={}) {
  const rows=new Map();
  const key=(owner,id)=>owner+'/'+id;
  const pool={async query(sql,args=[]) {
    options.onQuery?.(sql,args);
    if(sql.includes('pg_advisory')) return {rows:[]};
    if(sql.startsWith('SELECT')) {
      const values=args.length===2 ? [rows.get(key(...args))].filter(Boolean) : [...rows.values()].filter(row=>row.owner===args[0]);
      return {rows:structuredClone(values)};
    }
    const [owner,id]=args, existing=rows.get(key(owner,id));
    if(sql.startsWith('INSERT')) {
      if(existing) return {rows:[],rowCount:0};
      rows.set(key(owner,id),{owner,id,version:1,payload:JSON.parse(args[2])});
      return {rows:[{version:1}],rowCount:1};
    }
    if(sql.startsWith('UPDATE')) {
      if(!existing || existing.version!==args[2]) return {rows:[],rowCount:0};
      existing.payload=JSON.parse(args[3]); existing.version++;
      return {rows:[{version:existing.version}],rowCount:1};
    }
    throw new Error('Unexpected query: '+sql);
  }};
  const module={exports:{}};
  vm.runInNewContext(source,{module,Buffer,AbortController,clearTimeout,setTimeout:options.setTimeout || setTimeout,require(name) {
    if(name==='../storage') return {enabled:()=>true,getPool:()=>pool};
    if(name.endsWith('/pool')) return {transaction:async(_,fn)=>fn(pool)};
    if(name.endsWith('/crypto')) return {encrypt:value=>structuredClone(value),decrypt:value=>structuredClone(value)};
    if(name==='./ai_provider_manager') return {getActiveProvider:()=>({id:'p',model:'test'}),getProviderForExecution:()=>({id:'p',model:'test'})};
    if(name==='../intelligent_core/adapters') return {dispatchToProvider:options.dispatch || (async()=>({content:'Summary'}))};
    throw new Error(name);
  }});
  return module.exports;
}
function session(count=70) {
  const messages=Array.from({length:count},(_,i)=>({role:i%2?'assistant':'user',content:'message '+i,html:'<div>'+i+'</div>'}));
  return {id:'chat',version:0,title:'Test',messages,history:messages.map(({role,content})=>({role,content}))};
}

test('saving restored HTML preserves activity order while new messages advance it',async()=>{
  const updates=[];
  const api=fixture({onQuery(sql,args){if(sql.startsWith('UPDATE'))updates.push({sql,args});}});
  const chat={...session(2),createdAt:100,updatedAt:200};
  await api.save('a',{changes:[chat]});
  let stored=(await api.list('a'))[0];
  stored.messages[1].html='<div>Restored workflow card</div>';
  await api.save('a',{changes:[stored]});
  assert.equal(updates[0].args[4],false);
  assert.match(updates[0].sql,/CASE WHEN \$5::boolean THEN now\(\) ELSE updated_at END/);
  stored=(await api.list('a'))[0];assert.equal(stored.updatedAt,200);
  stored.messages.push({role:'user',content:'New question',html:'<div>New question</div>'});
  stored.history.push({role:'user',content:'New question'});stored.updatedAt=300;
  await api.save('a',{changes:[stored]});
  assert.equal(updates[1].args[4],true);
});
test('20-message pages cover the entire timeline without gaps and enforce account/version isolation',async()=> {
  const api=fixture(); await api.save('a',{changes:[session()]});
  let latest=(await api.list('a',true))[0];
  assert.equal(latest.messages.length,20); assert.equal(latest._page.start,50);
  let all=[...latest.messages];
  while(latest._page.start) {
    latest=await api.page('a','chat',latest._page.start,1);
    all.unshift(...latest.messages);
  }
  assert.deepEqual(all.map(item=>item.content),session().messages.map(item=>item.content));
  await assert.rejects(api.page('b','chat',20,1),error=>error.statusCode===404);
  await assert.rejects(api.page('a','chat',20,0),error=>error.statusCode===409);
  await assert.rejects(api.page('a','chat',-1,1),/INVALID_CHAT_CURSOR/);
});
test('saving a partially loaded chat retains older messages/history across repeated saves and reloads',async()=> {
  const api=fixture(); await api.save('a',{changes:[session()]});
  const partial=(await api.list('a',true))[0];
  partial.title='Renamed';
  let result=await api.save('a',{changes:[partial]}); partial.version=result.versions.chat;
  partial.messages.push({role:'user',content:'new question'});
  result=await api.save('a',{changes:[partial]}); partial.version=result.versions.chat;
  partial.messages.push({role:'assistant',content:'new answer'});
  partial.history.push({role:'user',content:'new question'},{role:'assistant',content:'new answer'});
  await api.save('a',{changes:[partial]});
  const full=(await api.list('a'))[0];
  assert.equal(full.title,'Renamed'); assert.equal(full.messages.length,72); assert.equal(full.history.length,72);
  assert.equal(full.messages[0].content,'message 0'); assert.equal(full.history[0].content,'message 0');
  const reloaded=(await api.list('a',true))[0];
  assert.equal(reloaded._page.start,52); assert.equal(reloaded.messages.at(-1).content,'new answer');
  await assert.rejects(api.save('a',{changes:[partial]}),error=>error.statusCode===409);
  reloaded.messages=[];
  await assert.rejects(api.save('a',{changes:[reloaded]}),/INCOMPLETE_CHAT_PAGE/);
});
test('80-message limit permits final answer, blocks more questions and preserves archived chats',async()=> {
  const api=fixture(); await api.save('a',{changes:[session(78)]});
  const partial=(await api.list('a',true))[0];
  partial.messages.push({role:'user',content:'last question'});
  partial.version=(await api.save('a',{changes:[partial]})).versions.chat;
  await api.assertCanChat('a','chat');
  partial.messages.push({role:'assistant',content:'last answer'});
  partial.version=(await api.save('a',{changes:[partial]})).versions.chat;
  partial.title='Archived';
  partial.version=(await api.save('a',{changes:[partial]})).versions.chat;
  partial.messages.push({role:'user',content:'over limit'});
  await assert.rejects(api.save('a',{changes:[partial]}),/CHAT_SESSION_LIMIT/);
  const full=(await api.list('a'))[0]; assert.equal(full.messages.length,80); assert.equal(full.title,'Archived');
  await assert.rejects(api.assertCanChat('a','chat'),error=>error.statusCode===409);
  const handoff=await api.continuation('a','chat',full.version);
  assert.ok(handoff.context.includes('message 0')); assert.ok(handoff.context.includes('message 77'));
});
test('UI counts unloaded messages toward 60-message warning and 80-message limit',()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const nodes=new Map();
  const create=()=>({children:[],setAttribute(name,value){this[name]=value;},append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}});
  const container=create(); container.after=node=>nodes.set(node.id,node);
  const composerArea={children:[],prepend(node){this.children.unshift(node);node.parentElement=this;nodes.set(node.id,node);}};
  nodes.set('page-chat-messages-container',container);
  const sandbox=vm.createContext({TextEncoder,window:{},document:{getElementById:id=>nodes.get(id),createElement:create,querySelector:()=>composerArea}});
  vm.runInContext(frontend.slice(frontend.indexOf('const chatPageLoads'),frontend.indexOf('async function loadOlderChatMessages')),sandbox);
  const chat={id:'chat',messages:session(20).messages,history:[],_page:{start:40,bytes:1000,loadedBytes:0}};
  sandbox.chat=chat; chat._page.loadedBytes=vm.runInContext('chatPayloadBytes(chat)',sandbox);
  vm.runInContext('renderChatLimitNotice(chat)',sandbox);
  assert.equal(nodes.get('chat-session-limit-notice').parentElement,composerArea,'Limit warning must be measured above the floating input, never behind it');
  assert.match(nodes.get('chat-session-limit-notice').children[0].textContent,/60\/80/);
  assert.equal(vm.runInContext('chatSessionIsFull(chat)',sandbox),false);
  const warning=nodes.get('chat-session-limit-notice');
  warning.children.find(node=>node.className==='chat-limit-dismiss').onclick();
  assert.equal(warning.hidden,true);
  vm.runInContext('renderChatLimitNotice(chat)',sandbox);
  assert.equal(warning.hidden,true,'Dismissal survives rerenders and returning to the conversation');
  sandbox.other={...chat,id:'other'};
  vm.runInContext('renderChatLimitNotice(other)',sandbox);
  assert.equal(warning.hidden,false,'Dismissal is scoped to one conversation');
  chat._page.start=60;
  assert.equal(vm.runInContext('chatSessionIsFull(chat)',sandbox),true);
  vm.runInContext('renderChatLimitNotice(chat)',sandbox);
  assert.equal(warning.hidden,false,'A full conversation must override a dismissed early warning');
  assert.equal(warning.children.some(node=>node.className==='chat-limit-dismiss'),false);
  chat.messages=[]; chat._page.start=0; chat.continuedFrom='previous';
  vm.runInContext('renderChatLimitNotice(chat)',sandbox);
  assert.equal(nodes.get('chat-session-limit-notice').hidden,true);
  assert.equal(nodes.get('chat-session-limit-notice').children.some(node=>node.className==='chat-limit-primary'),false);
  let selected=null;
  sandbox.selectChatSession=id=>{selected=id;};
  chat.messages=session(80).messages; chat.continuedTo='next';
  sandbox.window.chatSessions=[chat,{id:'next'}];
  vm.runInContext('renderChatLimitNotice(chat)',sandbox);
  nodes.get('chat-session-limit-notice').children.find(node=>node.className==='chat-limit-primary').onclick();
  assert.equal(selected,'next');
});
test('loading an older page preserves local edits and does not mark loaded history as a new edit',async()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const chat={id:'chat',title:'Test',messages:session(20).messages,history:[],_page:{start:40,bytes:1000,loadedBytes:0}};
  const older=session(20).messages.map(item=>({...item,content:'older '+item.content}));
  let renders=0;
  const sandbox=vm.createContext({TextEncoder,URLSearchParams,console,chat,
    window:{chatSessions:[chat],currentChatSessionId:'chat'},
    renderCurrentChatMessages:preserve=>{assert.equal(preserve,true); renders++;},
    showToast:message=>assert.fail(message),
    fetch:async()=> {
      // A local edit arriving while the request is in flight must stay dirty.
      chat.title='Local edit';
      return {ok:true,json:async()=>({session:{messages:older,_page:{start:20}}})};
    }});
  vm.runInContext(frontend.slice(frontend.indexOf('const chatPageLoads'),frontend.indexOf('async function continueChatSession')),sandbox);
  vm.runInContext('const persistedChatSessions=new Map(); function sessionSnapshot(session){const {version,...data}=session;return JSON.stringify(data);} function saveChatSessions(){return Promise.resolve(true);}',sandbox);
  vm.runInContext('chat._page.loadedBytes=chatPayloadBytes(chat); persistedChatSessions.set(chat.id,{version:1,snapshot:sessionSnapshot(chat)});',sandbox);
  await vm.runInContext('loadOlderChatMessages(chat)',sandbox);
  assert.equal(chat.messages.length,40); assert.equal(chat._page.start,20); assert.equal(renders,1);
  assert.equal(chat.title,'Local edit');
  assert.equal(vm.runInContext('JSON.parse(persistedChatSessions.get(chat.id).snapshot).title',sandbox),'Test');
  assert.equal(vm.runInContext('JSON.parse(persistedChatSessions.get(chat.id).snapshot).messages.length',sandbox),40);
  assert.equal(vm.runInContext('chatSessionUsage(chat).count',sandbox),60);
});
test('continuation failure keeps the original chat and success saves the summary before switching',async()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const original={id:'chat',title:'Original',messages:session(60).messages,history:[]};
  let fail=true,saves=0,selected=null;
  const notices=[];
  const sandbox=vm.createContext({URLSearchParams,AbortSignal,crypto:{randomUUID:()=> 'new'},pageChatProviderId:()=>null,
    window:{chatSessions:[original]},
    document:{getElementById:()=>null},
    renderChatLimitNotice(){}, renderChatSessionsList(){},getCurrentChatSession:()=>original,
    showToast:message=>notices.push(message),
    saveChatSessions:async()=>{saves++;return true;},chatSessionUsage:chat=>({count:chat.messages.length}),chatSessionIsFull:()=>false,
    persistedChatSessions:new Map([['chat',{version:1}]]),
    fetch:async()=>({ok:!fail,json:async()=>({summary:'Goals and pending work',mode:'summary'})}),
    selectChatSession:id=>{assert.ok(saves>=3);selected=id;}
  });
  vm.runInContext('const chatContinuations=new Set();',sandbox);
  vm.runInContext(frontend.slice(frontend.indexOf('async function continueChatSession'),frontend.indexOf('function sessionSnapshot')),sandbox);
  await vm.runInContext("continueChatSession('chat')",sandbox);
  assert.equal(sandbox.window.chatSessions.length,1); assert.equal(selected,null); assert.equal(notices.length,1);
  fail=false;
  await vm.runInContext("continueChatSession('chat')",sandbox);
  assert.equal(sandbox.window.chatSessions.length,2); assert.equal(selected,'session-new');
  assert.equal(sandbox.window.chatSessions[0].continuationSummary,'Goals and pending work');
  assert.equal(original.continuedTo,'session-new');
  await vm.runInContext("continueChatSession('chat')",sandbox);
  assert.equal(sandbox.window.chatSessions.length,2);
});
test('summary uses a single bounded model call without tools or reasoning',async()=> {
  let calls=0;
  const api=fixture({dispatch:async(provider,messages,tools,signal)=> {
    calls++; assert.equal(provider.think,false); assert.equal(provider.numPredict,700);
    assert.equal(tools.length,0); assert.ok(messages[1].content.length<15000); assert.equal(signal.aborted,false);
    return {content:'Goals and pending work'};
  }});
  await api.save('a',{changes:[session()]});
  const result=await api.summarize('a',{sessionId:'chat',version:1});
  assert.equal(calls,1); assert.equal(result.mode,'summary'); assert.equal(result.summary,'Goals and pending work');
  await assert.rejects(api.summarize('b',{sessionId:'chat',version:1}),error=>error.statusCode===404);
  await assert.rejects(api.summarize('a',{sessionId:'chat',version:0}),error=>error.statusCode===409);
});
test('slow summary is cancelled and returns clearly labelled excerpts',async()=> {
  let signal;
  const api=fixture({setTimeout:callback=>setTimeout(callback,0),dispatch:async(_provider,_messages,_tools,abortSignal)=> {
    signal=abortSignal; return new Promise(()=>{});
  }});
  await api.save('a',{changes:[session()]});
  const result=await api.summarize('a',{sessionId:'chat',version:1});
  assert.equal(signal.aborted,true); assert.equal(result.mode,'excerpt');
  assert.ok(result.summary.includes('message 0')); assert.ok(result.summary.includes('message 69'));
  assert.equal((await api.list('a'))[0].messages.length,70);
});
test('prepending old messages keeps the same visible scroll position',()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const children=[];
  const container={scrollTop:0,get scrollHeight(){return children.length*10;},
    set innerHTML(value){assert.fail('The scroll viewport must retain its content wrapper');}};
  const thread={set innerHTML(value){children.length=0;},append(...nodes){children.push(...nodes);},appendChild(node){children.push(node);}};
  const chat={messages:session(20).messages,history:[],_page:{start:40}};
  const sandbox=vm.createContext({window:{},document:{getElementById:id=>id==='page-chat-thread'?thread:container,createElement:()=>({})},
    getCurrentChatSession:()=>chat,renderChatLimitNotice(){},renderQuickPrompts(){},
    appendChatMessage(record){children.push(record);return false;}});
  vm.runInContext(frontend.slice(frontend.indexOf('function renderCurrentChatMessages('),frontend.indexOf('async function submitChatFeedback')),sandbox);
  vm.runInContext('renderCurrentChatMessages()',sandbox);
  assert.equal(children.length,21);
  container.scrollTop=10;
  chat.messages.unshift(...session(20).messages); chat._page.start=20;
  vm.runInContext('renderCurrentChatMessages(true)',sandbox);
  assert.equal(children.length,41); assert.equal(container.scrollTop,210);
});
test('retry replaces one answer at the 80-message limit, including history outside the loaded page',async()=> {
  const api=fixture(); const original=session(80);
  await api.save('a',{changes:[original]});
  const context=await api.assertCanChat('a','chat',79);
  assert.equal(context.history.length,20); assert.equal(context.history.at(-1).content,'message 77');
  await assert.rejects(api.assertCanChat('a','chat',0),/INVALID_CHAT_RETRY/);
  const result=await api.replaceAnswer('a',{sessionId:'chat',version:1,messageIndex:1,
    answer:{role:'assistant',content:'Regenerated',html:'<div>Regenerated</div>'},paged:true});
  assert.equal(result.version,2); assert.equal(result.historyStart,60);
  let full=(await api.list('a'))[0];
  assert.equal(full.messages.length,80); assert.equal(full.history.length,80);
  assert.equal(full.messages[0].content,'message 0'); assert.equal(full.messages[1].content,'Regenerated');
  assert.equal(full.history[1].content,'Regenerated'); assert.equal(full.messages[79].content,'message 79');
  const partial=(await api.list('a',true))[0]; partial.title='Rename after retry';
  await api.save('a',{changes:[partial]});
  full=(await api.list('a'))[0]; assert.equal(full.history[1].content,'Regenerated');
  await assert.rejects(api.replaceAnswer('a',{sessionId:'chat',version:1,messageIndex:1,answer:{role:'assistant',content:'stale',html:'stale'}}),error=>error.statusCode===409);
});
test('retrying a previously failed answer inserts its context before later turns',async()=> {
  const api=fixture(); const original=session(6);
  original.messages[1]={role:'assistant',html:'<div>Temporary error</div>'};
  original.history.splice(0,2);
  await api.save('a',{changes:[original]});
  await api.replaceAnswer('a',{sessionId:'chat',version:1,messageIndex:1,
    answer:{role:'assistant',content:'Recovered',html:'<div>Recovered</div>'},paged:true});
  const full=(await api.list('a'))[0];
  assert.equal(full.messages.length,6); assert.equal(full.history.length,6);
  assert.equal(full.history[0].content,'message 0'); assert.equal(full.history[1].content,'Recovered');
  assert.equal(full.history[2].content,'message 2');
});
test('retry failure preserves the answer, input draft and message count without appending user/error bubbles',async()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const chat=session(80); const answer=chat.messages[79], question=chat.messages[78];
  const input={value:'Unsent draft'}; let restored=0,payload;
  const node={style:{setProperty(){}},before(){}};
  const thinking={remove(){}};
  const sandbox=vm.createContext({AbortController,chatHistoryReady:Promise.resolve(),chatHistoryFailed:false,
    chatPageLoads:new Set(),chatContinuations:new Set(),
    window:{currentChatSessionId:'chat',pageChatAttachments:['keep'],updatePageChatMiniPanel(){}},
    document:{getElementById:id=>id==='page-chat-user-input'?input:id==='page-chat-messages-container'?{}:null},
    getCurrentChatSession:()=>chat,chatSessionIsFull:()=>true,chatSessionUsage:()=>({count:80}),
    createThinkingBubble:()=>thinking,disposeThinkingBubble(){},
    setPageChatResponding(){},saveChatSessions:async()=>true,
    getChatKnowledgeValues:()=>['none'],buildPageChatAttachmentContext:async()=>'',pageChatProviderId:()=>null,
    fetchStreamingChat:async data=>{payload=data;throw new Error('Model failed');},
    appendChatMessage:()=>assert.fail('Retry must not append a message on failure'),
    renderCurrentChatMessages:()=>{restored++;},showToast(){},
    retry:{session:chat,record:answer,questionRecord:question,node,historyIndex:78,index:79}
  });
  vm.runInContext(frontend.slice(frontend.indexOf('async function sendPageChatMessage('),frontend.indexOf('async function populateChatKnowledgeSources()')),sandbox);
  await vm.runInContext("sendPageChatMessage('message 78',retry)",sandbox);
  assert.equal(chat.messages.length,80); assert.equal(chat.messages[79],answer); assert.equal(answer.content,'message 79');
  assert.equal(input.value,'Unsent draft'); assert.equal(restored,1);
  assert.equal(payload.retryMessageIndex,79); assert.equal(payload.history.at(-1).content,'message 77');
});
test('workflow handoff is a usable retry result while ordinary partial answers and failed runs are rejected',()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const sandbox=vm.createContext({});
  vm.runInContext(frontend.slice(frontend.indexOf('function isPageChatRetryResultUsable('),frontend.indexOf('async function retryPageChatAnswer(')),sandbox);
  const usable=sandbox.isPageChatRetryResultUsable;
  for(const status of ['CREATED','WAITING_INPUT','READY','RUNNING','NEEDS_REVIEW','SUCCEEDED']) {
    assert.equal(usable({status:'success',completionStatus:'PARTIAL',execution:{id:'run',status}}),true,status);
  }
  for(const status of ['FAILED','CANCELLED','UNKNOWN']) {
    assert.equal(usable({status:'success',completionStatus:'PARTIAL',execution:{id:'run',status}}),false,status);
  }
  assert.equal(usable({completionStatus:'PARTIAL'}),false);
  assert.equal(usable({completionStatus:'SUCCESS'}),true);
  assert.equal(usable({status:'error',completionStatus:'PARTIAL',execution:{id:'run',status:'RUNNING'}}),false);
  assert.equal(usable({completionStatus:'PARTIAL',execution:{status:'RUNNING'}}),false);
  const partial={status:'success',completionStatus:'PARTIAL',retryDisposition:'verified_partial',reply:'Chưa đủ lịch sử; đã đối chiếu dữ liệu thực tế.',toolCalls:[{name:'execute_sql_query',success:true}]};
  assert.equal(usable(partial),true,'Verified analytical limitation replaces the old failed answer');
  assert.equal(usable({...partial,reply:''}),false);
  assert.equal(usable({...partial,toolCalls:[{name:'execute_sql_query',success:false}]}),false);
  assert.equal(usable({...partial,retryDisposition:null}),false);
  assert.equal(usable({...partial,status:'error'}),false);
});
test('model suggestions are bounded, deduplicated and scoped to the latest answer',async()=> {
  let calls=0;
  const api=fixture({dispatch:async(provider,messages,tools)=>{
    calls++; assert.equal(tools.length,0); assert.equal(provider.think,false);
    assert.ok(messages[0].content.includes('không soạn lời của trợ lý'));
    assert.equal(JSON.parse(messages[1].content).lastAssistantMessage,'Bạn muốn thống kê theo tháng hay năm?');
    return {content:JSON.stringify([{speaker:'user',label:'Theo tháng',prompt:'Thống kê theo tháng'},{speaker:'user',label:'Theo năm',prompt:'Thống kê theo năm'},
      {speaker:'user',label:'Trùng',prompt:'Thống kê theo tháng'},{speaker:'user',label:'Invalid',prompt:'x'.repeat(301)},
      {speaker:'assistant',label:'Sai vai',prompt:'Bạn cần hỗ trợ gì?'},{label:'Cũ',prompt:'Bạn cần gì?'}])};
  }});
  const chat=session(2); chat.messages[1].content='Bạn muốn thống kê theo tháng hay năm?';
  await api.save('a',{changes:[chat]});
  const result=await api.suggestReplies('a',{sessionId:'chat',version:1,messageIndex:1});
  assert.equal(calls,1); assert.equal(result.suggestions.length,2); assert.equal(result.suggestions[0].prompt,'Thống kê theo tháng');
  assert.equal((await api.suggestReplies('a',{sessionId:'chat',version:1,messageIndex:0})).suggestions.length,0);
  await assert.rejects(api.suggestReplies('b',{sessionId:'chat',version:1,messageIndex:1}),error=>error.statusCode===404);
});
test('ordinary answers and workflow forms do not trigger extra suggestion calls',async()=> {
  let calls=0; const api=fixture({dispatch:async()=>{calls++;return {content:'[]'};}});
  const chat=session(2); chat.messages[1].content='Đã tra cứu được kết quả.';
  await api.save('a',{changes:[chat]});
  assert.equal((await api.suggestReplies('a',{sessionId:'chat',version:1,messageIndex:1})).suggestions.length,0);
  const stored=(await api.list('a'))[0]; stored.messages[1].content='Bạn muốn bổ sung thông tin?'; stored.messages[1].executionId='run';
  await api.save('a',{changes:[stored]});
  assert.equal((await api.suggestReplies('a',{sessionId:'chat',version:2,messageIndex:1})).suggestions.length,0);
  assert.equal(calls,0);
});
test('contextual chips survive default refresh and only fill a draft when clicked',()=> {
  const frontend=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const chips=[]; let draft='';
  const chat={id:'a',messages:[{role:'assistant',followUpSuggestions:[{speaker:'user',label:'Theo tháng',prompt:'Thống kê theo tháng',icon:'fa-reply'}]}]};
  const container={replaceChildren(){chips.length=0;},appendChild(node){chips.push(node);}};
  const context=vm.createContext({window:{chatSessions:[chat],currentChatSessionId:'a'},
    document:{getElementById:()=>container,createTextNode:text=>({textContent:text}),createElement:()=>({children:[],style:{setProperty(){}},setAttribute(){},append(...nodes){this.children.push(...nodes);}})},
    useQuickPrompt:prompt=>{draft=prompt;}});
  vm.runInContext(frontend.slice(frontend.indexOf('function renderQuickPrompts('),frontend.indexOf('async function requestPageChatSuggestions(')),context);
  const defaults=[{label:'Default',prompt:'Default question',icon:'fa-lightbulb'}];
  context.renderQuickPrompts(defaults); assert.equal(chips[0].children[1].textContent,'Theo tháng');
  chat.messages[0].followUpSuggestions.push({speaker:'assistant',label:'Sai vai',prompt:'Bạn cần hỗ trợ gì?'});
  context.renderQuickPrompts(defaults);assert.equal(chips.length,1);
  const valid=chat.messages[0].followUpSuggestions;
  chat.messages[0].followUpSuggestions=[{label:'Gợi ý cũ',prompt:'Bạn cần hỗ trợ gì?'}];
  context.renderQuickPrompts(defaults);assert.equal(chips.length,0);assert.equal(container.hidden,true);
  chat.messages[0].followUpSuggestions=valid;
  context.renderQuickPrompts(defaults);
  chips[0].onclick(); assert.equal(draft,'Thống kê theo tháng'); assert.equal(chat.messages.length,1);
  context.renderQuickPrompts(defaults); assert.equal(chips[0].children[1].textContent,'Theo tháng');
  chat.messages.push({role:'user',content:'New question'});
  context.renderQuickPrompts(defaults); assert.equal(chips.length,0);assert.equal(container.hidden,true);
});
