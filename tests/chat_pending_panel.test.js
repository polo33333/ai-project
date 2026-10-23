'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/frontend/js/modules/page_chat.js'), 'utf8');
function extract(name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`\n${next}`, source.indexOf(`function ${name}(`)));
}
function loadReasoningUI(context) {
  context.requestAnimationFrame ||= () => {};
  context.clearInterval ||= () => {};
  context.window.matchMedia ||= () => ({ matches: true });
  context.document ||= {};
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../src/frontend/js/chat_reasoning_ui.js'),'utf8'),context);
}

test('scroll activity appears only while answering above the bottom and lets the reader return explicitly',()=>{
  let active=false,button,created=0;const listeners={};
  const container={scrollHeight:1000,clientHeight:300,scrollTop:700,addEventListener(name,fn){listeners[name]=fn;},scrollTo(options){this.lastScroll=options;this.scrollTop=options.top;listeners.scroll();}};
  const anchor={before(node){button=node;node.isConnected=true;}};
  const context=vm.createContext({window:{matchMedia:()=>({matches:false})},document:{createElement(){created++;return {setAttribute(){}};}},MutationObserver:class{constructor(fn){this.fn=fn;}observe(){}},ResizeObserver:class{observe(){}}});
  loadReasoningUI(context);const watch=context.window.ChatReasoningUI.watchActivity;
  watch(container,anchor,()=>active);assert.equal(button.hidden,true);
  active=true;watch(container,anchor,()=>active);assert.equal(button.hidden,true);
  container.scrollTop=150;listeners.scroll();assert.equal(button.hidden,false);assert.equal(container.scrollTop,150);
  button.onclick();assert.equal(container.lastScroll.top,1000);assert.equal(button.hidden,true);
  container.scrollTop=150;active=false;listeners.scroll();assert.equal(button.hidden,true);
  active=true;watch(container,anchor,()=>false);assert.equal(button.hidden,true);assert.equal(created,1);
});

test('page chat keeps one down-arrow control after completion and combines the responding indicator inside it',()=>{
 let active=false,button,created=0,resumed=0;const listeners={};
 const container={children:[],scrollHeight:1200,clientHeight:300,scrollTop:200,addEventListener(name,fn){listeners[name]=fn;},scrollTo(value){this.scrollTop=value.top;listeners.scroll();}};
 const anchor={before(node){button=node;node.isConnected=true;}};
 const context=vm.createContext({window:{matchMedia:()=>({matches:false}),ChatStream:{followResponse:()=>({resume(){resumed++;}})}},
  document:{createElement(){created++;return {attributes:{},setAttribute(key,value){this.attributes[key]=value;}};}},
  MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}unobserve(){}}});
 loadReasoningUI(context);const watch=context.window.ChatReasoningUI.watchActivity,options={showWhenIdle:true,arrow:true};
 watch(container,anchor,()=>active,options);
 assert.equal(button.hidden,false);assert.ok(button.innerHTML.includes('fa-arrow-down'));assert.equal(button.attributes['data-active'],'false');
 active=true;watch(container,anchor,()=>active,options);
 assert.equal(created,1);assert.equal(button.attributes['data-active'],'true');assert.ok(button.title.includes('AI đang trả lời'));
 active=false;watch(container,anchor,()=>active,options);assert.equal(button.hidden,false);
 active=true;button.onclick();assert.equal(resumed,1);assert.equal(button.hidden,true);
});

test('returning to the request session restores the same pending panel after history rendering', () => {
  const node = { id: 'thinking-test' };
  const children = [];
  const container = { set innerHTML(value) { children.length = 0; }, appendChild(value) { children.push(value); }, scrollHeight: 10 };
  let session = { id: 'owner', messages: [{ role: 'user' }] };
  const context = vm.createContext({
    window: { pageChatPendingThinking: { sessionId: 'owner', node } },
    document: { getElementById: () => container },
    getCurrentChatSession: () => session,
    renderChatLimitNotice() {},
    renderQuickPrompts() {},
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
  loadReasoningUI(context);
  vm.runInContext(extract('addThinkingStep', 'function finalizeThinkingBubble'), context);
  vm.runInContext("addThinkingStep('thinking-test', 'spinner', 'Đang truy vấn', 'running')", context);
  assert.equal(label.textContent, 'Đang truy vấn');
  assert.equal(steps.length, 0);
});

test('reasoning streams as readable text without a timeline and keeps its stage identity', () => {
  function element() { return { dataset: {}, children: [], textContent: '', appendChild(child) { this.children.push(child); }, querySelector(tag) { return this.children.find(child => child.tag === tag); } }; }
  const steps = element();
  steps.hidden = true;
  const current = {};
  const node = { id: 'thinking-test', querySelector: selector => selector === '.chat-thinking-steps' ? steps : current };
  const updates = [];
  const timers = new Map(); let timerId = 0;
  const flush = () => { for (let i=0;i<400;i++) for (const callback of timers.values()) callback(); };
  const context = vm.createContext({ setInterval: callback => { timers.set(++timerId,callback); return timerId; }, clearInterval: id => timers.delete(id), typeThinkingText: (element, text, key) => updates.push({ element, text, key }), window: { pageChatPendingThinking: { node } }, document: {
    getElementById: () => null, createElement: tag => Object.assign(element(), { tag })
  } });
  loadReasoningUI(context);
  vm.runInContext(extract('addThinkingStep', 'function finalizeThinkingBubble'), context);
  vm.runInContext(`addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, delta: '<script>' });
    addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, delta: 'text' });`, context);
  assert.equal(steps.children.length, 1);
  assert.equal(steps.children[0].textContent, '');
  assert.equal(timers.size, 1);
  flush();
  assert.equal(steps.children[0].textContent, '<script>text');
  assert.equal(steps.children[0].tag, 'pre');
  assert.equal(steps.hidden, false);
  assert.equal(current.textContent, '');
  vm.runInContext(`addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, reasoningId: 'routing:1', delta: 'Routing summary' });
    addThinkingStep('thinking-test', 'brain', 'Reasoning', 'running', { type: 'reasoning_delta', iteration: 1, reasoningId: 'workflow:explanation', delta: 'Explanation summary' });`, context);
  assert.equal(steps.children.length, 3);
  flush();
  assert.equal(steps.children[1].textContent, 'Routing summary');
  assert.equal(steps.children[2].textContent, 'Explanation summary');
  node._reasoningCollapsed=true;
  vm.runInContext(`addThinkingStep('thinking-test', 'brain', '', 'running', { type: 'reasoning_delta', iteration: 1, delta: 'more' });`,context);
  assert.equal(steps.hidden,true);
  flush();
  assert.equal(timers.size,0);
});

test('reasoning follows new text in both scroll areas and respects scrolling up', () => {
  let tick;
  const content = { hidden:false, clientHeight:100, scrollHeight:200, scrollTop:100, appendChild() {} };
  const messages = { clientHeight:400, scrollHeight:800, scrollTop:400 };
  let value = '';
  const block = { get textContent() { return value; }, set textContent(text) { value=text; content.scrollHeight+=20; messages.scrollHeight+=20; } };
  const root = { closest:()=>messages, querySelector:selector=>selector==='.chat-thinking-steps'?content:{} };
  const context = vm.createContext({window:{},document:{createElement:()=>block},setInterval:callback=>{tick=callback;return 1;},clearInterval() {}});
  loadReasoningUI(context);
  context.window.ChatReasoningUI.update(root,{type:'reasoning_delta',delta:'a'.repeat(500)});
  tick();
  assert.equal(content.scrollTop,content.scrollHeight);
  assert.equal(messages.scrollTop,messages.scrollHeight);
  content.scrollTop=0; messages.scrollTop=0;
  tick();
  assert.equal(content.scrollTop,0);
  assert.equal(messages.scrollTop,0);
  content.scrollTop=content.scrollHeight-content.clientHeight;
  messages.scrollTop=messages.scrollHeight-messages.clientHeight;
  tick();
  assert.equal(content.scrollTop,content.scrollHeight);
  assert.equal(messages.scrollTop,messages.scrollHeight);
});

test('fast mode ignores reasoning deltas while preserving processing status',()=>{
  const status={textContent:''};
  const root={_hideReasoning:true,querySelector:()=>status};
  const context=vm.createContext({window:{}}); loadReasoningUI(context);
  context.window.ChatReasoningUI.update(root,{type:'reasoning_delta',delta:'provider text'});
  assert.equal(status.textContent,'');
  context.window.ChatReasoningUI.update(root,{type:'tool_start'},'Processing');
  assert.equal(status.textContent,'Processing');
});

test('completed replies omit reasoning even when the provider supplied it',()=>{
 const context=vm.createContext({window:{}});loadReasoningUI(context);
 const render=context.window.ChatReasoningUI.render;
 assert.equal(render([{type:'tool_start',label:'Đang truy vấn'}]),'');
 const html=render([{type:'reasoning_delta',reasoningId:'a',delta:'<script>'},{type:'tool_done',label:'SQL tools'}, {type:'reasoning_delta',reasoningId:'a',delta:'example'}],'2s');
 assert.equal(html,'');
});

test('restoring old replies removes reasoning while preserving results and renaming technical details',()=>{
 const context=vm.createContext({window:{}});loadReasoningUI(context);
 let removed=0;const label={textContent:'Thinking · Quá trình xử lý'};
 const root={querySelectorAll:selector=>selector.startsWith('.chat-reasoning-summary')?[{remove(){removed++;}},{remove(){removed++;}}]:[label]};
 assert.equal(context.window.ChatReasoningUI.stripCompleted(root),true);
 assert.equal(removed,2);assert.equal(label.textContent,'Chi tiết truy vấn');
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
