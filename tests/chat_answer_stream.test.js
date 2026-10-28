'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createAnswerStream}=require('../src/backend/services/chat_answer_stream');

test('public complete words preview before a paragraph ends; reasoning, split secrets and final tails stay gated',()=>{
 const events=[];let clock=0;
 const stream=createAnswerStream(event=>events.push(event),{now:()=>clock});
 const privatePrefix=stream.begin(true);
 privatePrefix.push('<think>Private planning with <final_answer>fake\n\n');assert.equal(events.length,0);
 const candidate=stream.begin(true);events.length=0;
 candidate.push('<final_');assert.equal(events.length,0);
 clock=100;candidate.push('answer>Xin chào.\n\nAPI key: sk-abcdefghijkl');
 assert.equal(events[1].delta,'Xin chào.\n\nAPI key: ');
 assert.ok(!JSON.stringify(events).includes('sk-abcdefghijkl'));
 candidate.push('mnopqrstuvwxyz123456\n\nPhần cuối.</final_answer>private');
 assert.ok(!JSON.stringify(events).includes('sk-abcdefghijklmnopqrstuvwxyz'));
 assert.ok(!JSON.stringify(events).includes('Private planning'));assert.ok(!JSON.stringify(events).includes('Phần cuối'));
 clock=500;stream.commit({success:true,completionStatus:'SUCCESS',replyText:'Xin chào.\n\nĐã xác minh.'});
 assert.ok(events.some(event=>event.type==='answer_reset'));
 assert.equal(events.filter(event=>event.type==='answer_start').at(-1).verified,true);
 assert.equal(stream.metrics.firstAnswerMs,100);assert.equal(stream.metrics.verifiedAnswerMs,500);
 const privateCandidate=stream.begin(true);const before=events.length;privateCandidate.push('<think>hidden\n\n</think>Not wrapped\n\n');assert.equal(events.length,before);
});

test('business results, failed completions, cancellation and the feature flag never expose model drafts',()=>{
 const events=[];const controller=new AbortController();
 const stream=createAnswerStream(event=>events.push(event),{signal:controller.signal});
 stream.begin(false).push('<final_answer>Unverified SQL values\n\n');assert.equal(events.length,0);
 stream.commit({success:true,completionStatus:'PARTIAL',replyText:'Unverified'});assert.equal(events.length,0);
 stream.begin(true).push('<final_answer>Old draft\n\n');stream.reset();
 const prior=events.length;controller.abort();stream.begin(true).push('<final_answer>After abort\n\n');assert.equal(events.length,prior);
 const disabled=createAnswerStream(event=>events.push(event),{enabled:false});disabled.begin(true).push('<final_answer>Disabled\n\n');disabled.commit({success:true,completionStatus:'SUCCESS',replyText:'Disabled'});assert.equal(events.length,prior);
});

test('the guarded harness previews tool-free general answers but withholds data stages',async()=>{
 const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
 const Manager=require('../src/backend/agent/tools/tool_manager');
 for(const mode of ['general','data']){
  const events=[];const stream=createAnswerStream(event=>events.push(event));
  const result=await new Harness({toolManager:new Manager(),dispatch:async(_provider,_messages,_tools,_signal,options)=>{
   options.onAnswer?.('<final_answer>Đoạn đầu.\n\n');
   if(mode==='general')assert.ok(events.some(event=>event.type==='answer_delta'));
   else assert.equal(events.length,0);
   return {content:'<final_answer>Đoạn đầu.\n\nĐoạn cuối.</final_answer>',finish_reason:'stop'};
  }}).run({userMessage:'Explain a concept',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:[],context:{mode,lockProvider:true,answerStream:stream,requestPlan:{intent:'general',outputs:{data:false,chart:false,export:false}}}});
  assert.ok(result.replyText.includes('Đoạn đầu'));
 }
});

function browserReader(){const context=vm.createContext({window:{},TextDecoder,Uint8Array,JSON,Error});vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);return context.window.ChatStream.read;}

test('response scrolling follows delayed result growth and preserves an intentional scroll upward',()=>{
 const frames=[],listeners={};let resize,mutate;
 const child={},scroller={children:[child],clientHeight:300,scrollHeight:1000,_top:700,
  get scrollTop(){return this._top;},set scrollTop(top){this._top=Math.min(top,this.scrollHeight-this.clientHeight);},
  addEventListener(type,fn){listeners[type]=fn;}};
 const context=vm.createContext({window:{ResizeObserver:class{constructor(fn){resize=fn;}observe(){}unobserve(){}},MutationObserver:class{constructor(fn){mutate=fn;}observe(){}}},setTimeout:fn=>frames.push(fn)});
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 const follower=context.window.ChatStream.followResponse(scroller),flush=()=>{while(frames.length)frames.shift()();};flush();
 scroller.scrollHeight=1800;resize();flush();assert.equal(scroller.scrollTop,1500,'follow table layout after final rendering');
 scroller.scrollTop=900;listeners.scroll();assert.equal(follower.following,false);
 scroller.scrollHeight=2300;mutate();resize();flush();assert.equal(scroller.scrollTop,900,'reader position must survive workflow growth');
 scroller.scrollTop=2000;listeners.scroll();scroller.scrollHeight=2600;resize();flush();assert.equal(scroller.scrollTop,2300);
 assert.equal(context.window.ChatStream.followResponse(scroller),follower,'reuse observers across turns');
});

test('UI-style registered tools do not block a resolved general answer, and tool calls cancel the preview',async()=>{
 const Harness=require('../src/backend/agent/harness/guarded_agent_harness');
 const Manager=require('../src/backend/agent/tools/tool_manager'),Base=require('../src/backend/agent/tools/base_tool');
 const manager=new Manager(),tool=new Base({name:'get_current_datetime',description:'Current time',parameters:{type:'object',properties:{}}});tool.run=async()=>{throw Error('Tool must not run for this explanation');};manager.registerTool(tool);
 for(const sourceScope of ['general','enterprise']){
  const events=[],stream=createAnswerStream(event=>events.push(event));let answered=false;
  const result=await new Harness({toolManager:manager,dispatch:async(_provider,_messages,definitions,_signal,options)=>{
   if(definitions[0]?.function.name==='resolve_conversation')return {content:JSON.stringify({relation:'independent',operation:'conversation',cardinality:'none',attributes:[],selectedIds:[],clarification:'',dataUse:'none',sourceScope})};
   assert.ok(definitions.length>0,'match the real UI: tools remain available');
   options.onAnswer('<final_answer>Một câu trả lời ');
   assert.equal(events.some(event=>event.type==='answer_delta'),sourceScope==='general','do not wait for a paragraph or model completion');
   if(sourceScope==='general'){
    options.onToolCall();assert.equal(events.at(-1).type,'answer_reset');
    const count=events.length;options.onAnswer('must not leak after a tool call ');assert.equal(events.length,count);
   }
   answered=true;return {content:'<final_answer>Một câu trả lời hoàn chỉnh.</final_answer>',finish_reason:'stop'};
  }}).run({userMessage:'Explain streaming',provider:{id:'fixture',supportsToolCalling:true},enabledToolNames:['get_current_datetime'],context:{governedController:true,lockProvider:true,mode:'general',answerStream:stream,resolutionContext:{candidates:[],recent:[{role:'user',content:'Previous question'}]},requestPlan:{intent:'general',outputs:{data:false,chart:false,export:false}}}});
  assert.equal(answered,true);assert.ok(result.replyText.includes('hoàn chỉnh'));
 }
});

test('HTTP client receives the first visible answer before the model and final response finish',async t=>{
 const http=require('node:http');let release,finished=false;
 const pending=new Promise(resolve=>{release=resolve;});
 const server=http.createServer(async(_req,res)=>{
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
  const stream=createAnswerStream(event=>res.write('event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n'));
  const preview=stream.begin(true);preview.push('<final_answer>Đang trả lời thực sự ');
  await pending;finished=true;stream.commit({success:true,completionStatus:'SUCCESS',replyText:'Đã hoàn tất'});
  res.end('event: final\ndata: {"reply":"Đã hoàn tất"}\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{release();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 let first;const firstAnswer=new Promise(resolve=>{first=resolve;});
 const response=await fetch('http://127.0.0.1:'+server.address().port);
 const result=browserReader()(response,{onAnswer:event=>{if(event.type==='answer_delta')first(event.delta);}});
 assert.equal(await firstAnswer,'Đang trả lời thực sự ');assert.equal(finished,false);
 release();assert.equal((await result).reply,'Đã hoàn tất');
});

test('SSE parser preserves split UTF-8 and mixed frame delimiters, returning final without waiting for EOF',async()=>{
 const events=[],read=browserReader();
 const wire='event: answer_start\r\ndata: {"id":"a"}\r\n\r\nevent: answer_delta\ndata: '+JSON.stringify({id:'a',seq:1,delta:'Tiếng Việt 😊'})+'\n\nevent: final\r\ndata: {"status":"success","reply":"Done"}\r\n\r\n';
 const bytes=new TextEncoder().encode(wire);let i=0,cancelled=false;
 const reader={async read(){if(i>=bytes.length)throw new Error('Should return before reading EOF');return {value:bytes.slice(i,i+++1),done:false};},async cancel(){cancelled=true;},releaseLock(){}};
 const result=await read({ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:{getReader:()=>reader}},{onAnswer:event=>events.push(event)});
 assert.equal(result.reply,'Done');assert.equal(events[1].delta,'Tiếng Việt 😊');assert.equal(cancelled,true);
});
test('truncated and error streams discard the transient answer instead of committing partial history',async()=>{
 for(const ending of ['', 'event: error\ndata: {"message":"Provider failed"}\n\n']){
  const events=[],read=browserReader();let reads=0;
  const reader={async read(){return reads++?{done:true}:{done:false,value:new TextEncoder().encode('event: answer_start\ndata: {"id":"a"}\n\n'+ending)};},async cancel(){},releaseLock(){}};
  await assert.rejects(read({ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:{getReader:()=>reader}},{onAnswer:event=>events.push(event)}));
  assert.equal(events.at(-1).type,'answer_reset');
 }
});

test('answer preview remains transient, ignores stale/duplicate events and respects the reader scroll position',()=>{
 const frames=new Map();let nextFrame=0;
 const scroller={scrollHeight:1000,clientHeight:300,scrollTop:150};
 const classes=new Set(),host={children:[],classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)},append(node){this.children.push(node);},closest:()=>scroller};
 const context=vm.createContext({window:{},TextDecoder,Uint8Array,JSON,Error,
  setTimeout:fn=>{frames.set(++nextFrame,fn);return nextFrame;},clearTimeout:id=>frames.delete(id),
  document:{createElement(){return {style:{},setAttribute(){},remove(){host.children=host.children.filter(node=>node!==this);}};}}});
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 const preview=context.window.ChatStream.createPreview(host),flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());};
 preview.update({type:'answer_start',id:'a'});
 preview.update({type:'answer_delta',id:'old',seq:1,delta:'Wrong'});
 preview.update({type:'answer_delta',id:'a',seq:1,delta:'<script>text only</script>'});flush();
 assert.equal(host.children[0].textContent,'<script>text only</script>');assert.equal(host.children[0].innerHTML,undefined);assert.equal(scroller.scrollTop,150);
 preview.update({type:'answer_delta',id:'a',seq:1,delta:'duplicate'});flush();assert.equal(host.children[0].textContent,'<script>text only</script>');
 scroller.scrollTop=700;preview.update({type:'answer_delta',id:'a',seq:2,delta:' More'});flush();assert.equal(scroller.scrollTop,1000);
 preview.update({type:'answer_reset',id:'old'});assert.equal(host.children.length,1);
 preview.update({type:'answer_reset',id:'a'});assert.equal(host.children.length,0);
 preview.update({type:'answer_start',id:'b'});preview.update({type:'answer_delta',id:'b',seq:1,delta:'pending'});preview.dispose();flush();
 assert.equal(host.children.length,0);assert.equal(classes.size,0);
});

test('readable page chat pace slows large bursts and allows four seconds to finish',async()=>{
 const timers=new Map();let next=0,now=0;
 const host={children:[],classList:{add(){},remove(){}},append(node){this.children.push(node);},closest:()=>null};
 const context=vm.createContext({window:{},Date:{now:()=>now},
  setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
  document:{createElement(){return {style:{},setAttribute(){},remove(){host.children=host.children.filter(node=>node!==this);}};}}});
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 const preview=context.window.ChatStream.createPreview(host,{charactersPerSecond:200,finishDurationMs:4000});
 const flush=()=>{now+=24;const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());};
 const text='Readable answer. '.repeat(200);
 preview.update({type:'answer_start',id:'paced',verified:true,animate:true});
 preview.update({type:'answer_delta',id:'paced',seq:1,delta:text});
 for(let i=0;i<10;i++)flush();
 assert.equal(host.children[0].textContent.length,50,'about 200 characters per second without burst acceleration');
 let finished=false;
 const completion=preview.update({type:'answer_complete'}).then(()=>{finished=true;});
 const started=now;
 while(now-started<600)flush();
 await Promise.resolve();assert.equal(finished,false,'do not rush the remaining answer within the old 600ms window');
 for(let i=0;i<180&&timers.size;i++)flush();
 await completion;
 assert.equal(host.children[0].textContent,text);
 assert(now-started<=4050);
 preview.dispose();assert.equal(timers.size,0);
});

test('live and verified answers paint progressively and final waits for pending visible text',async()=>{
 for(const start of [{verified:false},{verified:true,animate:true}]){
 const timers=new Map();let next=0;
 const host={children:[],classList:{add(){},remove(){}},append(node){this.children.push(node);},closest:()=>null};
 const context=vm.createContext({window:{},TextDecoder,Uint8Array,JSON,Error,Date,
  setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
  document:{createElement(){return {style:{},setAttribute(){},remove(){host.children=host.children.filter(node=>node!==this);}};}}});
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 const preview=context.window.ChatStream.createPreview(host),flush=()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());};
 const text='A long provider chunk. '.repeat(100);
 preview.update({type:'answer_start',id:'a',...start});
 preview.update({type:'answer_delta',id:'a',seq:1,delta:text});flush();
 const first=host.children[0].textContent;
 assert.ok(first.length>0&&first.length<text.length,'the first paint must not reveal a whole large chunk');
 let finished=false;
 const completion=preview.update({type:'answer_complete'}).then(()=>{finished=true;});
 await Promise.resolve();assert.equal(finished,false);
 for(let i=0;i<100&&timers.size;i++)flush();
 await completion;assert.equal(host.children[0].textContent,text);assert.equal(finished,true);
 preview.dispose();assert.equal(timers.size,0);
 }
});

test('rich preview renders table rows progressively using the final Markdown parser',async()=>{
 const timers=new Map();let next=0;
 const host={children:[],classList:{add(){},remove(){}},append(node){this.children.push(node);},closest:()=>null};
 const context=vm.createContext({window:{},URL,Date,
  setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),
  document:{createElement(){return {style:{},querySelectorAll(){return [];},setAttribute(){},remove(){host.children=[];}};}}});
 const source=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
 vm.runInContext(source.slice(source.indexOf('function escapeChatMarkdown'),source.indexOf('// Render Chart.js')),context);
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 const preview=context.window.ChatStream.createPreview(host,{renderMarkdown:context.parseMarkdown});
 const flush=()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());};
 const text='| Name | Value |\n| --- | --- |\n'+Array.from({length:30},(_,i)=>`| Row ${i} | ${i} |`).join('\n')+'\n| Unsafe | <script>alert(1)</script> |';
 preview.update({type:'answer_start',id:'table',verified:true,animate:true});
 preview.update({type:'answer_delta',id:'table',seq:1,delta:text});
 for(let i=0;i<3;i++)flush();
 assert.match(host.children[0].innerHTML,/chat-markdown-table-wrap/);
 assert.doesNotMatch(host.children[0].innerHTML,/Row 29/);
 const complete=preview.update({type:'answer_complete'});
 for(let i=0;i<100&&timers.size;i++)flush();
 await complete;
 assert.equal(host.children[0].innerHTML,context.parseMarkdown(text));
 assert.match(host.children[0].innerHTML,/Row 29/);
 assert.doesNotMatch(host.children[0].innerHTML,/<script>/);
 preview.update({type:'answer_reset'});
 assert.equal(host.children.length,0);
});

test('verified business replies reveal Markdown tables but retain code and JSON for final rendering',()=>{
 for(const executionMode of ['sql','workflow']){
  const events=[],stream=createAnswerStream(event=>events.push(event));
  stream.begin(false).push('<final_answer>Unverified draft ');
  assert.equal(events.length,0);
  stream.commit({success:true,completionStatus:'SUCCESS',executionMode,replyText:'Verified introduction.\n\n| Column |\n| --- |\n'});
  assert.equal(events[0].verified,true);assert.equal(events[0].animate,true);
  assert.equal(events.filter(event=>event.type==='answer_delta').map(event=>event.delta).join(''),'Verified introduction.\n\n| Column |\n| --- |');
 }
 const events=[],stream=createAnswerStream(event=>events.push(event));
 stream.commit({success:true,completionStatus:'SUCCESS',replyText:'| Column |\n| --- |'});
 assert.equal(events.filter(event=>event.type==='answer_delta').map(event=>event.delta).join(''),'| Column |\n| --- |');
 const codeEvents=[],codeStream=createAnswerStream(event=>codeEvents.push(event));
 codeStream.commit({success:true,completionStatus:'SUCCESS',replyText:'Introduction.\n\n```json\n{"private":"value"}\n```'});
 assert.equal(codeEvents.filter(event=>event.type==='answer_delta').map(event=>event.delta).join(''),'Introduction.');
});

test('verification retains the same preview and emits only its missing tail',()=>{
 const events=[],stream=createAnswerStream(event=>events.push(event));
 stream.begin(true).push('<final_answer>Hello world ');
 const id=events[0].id;
 stream.commit({success:true,completionStatus:'SUCCESS',replyText:'Hello world complete.'});
 assert.equal(events.filter(event=>event.type==='answer_start').length,1);
 assert.equal(events.some(event=>event.type==='answer_reset'),false);
 assert.equal(events.at(-1).id,id);assert.equal(events.at(-1).delta,'complete.');
 const padded=[],second=createAnswerStream(event=>padded.push(event));
 second.begin(true).push('<final_answer>\n\nHello world.\n\n</final_answer>');
 second.commit({success:true,completionStatus:'SUCCESS',replyText:'Hello world.'});
 assert.equal(padded.filter(event=>event.type==='answer_start').length,1);
 assert.equal(padded.some(event=>event.type==='answer_reset'),false);
});

test('core sends only verified successful final text and clears previews when the request fails',async t=>{
 const core=require('../src/backend/assistant/core'),events=[];
 t.mock.method(core,'_chat',async()=>({success:true,completionStatus:'SUCCESS',replyText:'Verified',toolCalls:[],trace:{completionStatus:'SUCCESS'}}));
 const result=await core.chat('test',{onAnswer:event=>events.push(event)});
 assert.ok(events.some(event=>event.type==='answer_delta'&&event.delta==='Verified'));
 assert.equal(result.trace.streaming.enabled,true);
 t.mock.method(core,'_chat',async(_question,options)=>{options.answerStream.begin(true).push('<final_answer>Draft\n\n');throw Error('Failed');});
 events.length=0;await assert.rejects(core.chat('test',{onAnswer:event=>events.push(event)}),/Failed/);assert.equal(events.at(-1).type,'answer_reset');
});

test('Gemini, OpenAI, Responses and Ollama publish answer deltas while their upstream stream is still open',async t=>{
 const cases=[
  {module:'gemini',name:'callGemini',format:'sse',chunks:[{candidates:[{content:{parts:[{thought:true,text:'private'},{text:'Hello '}]}}]},{candidates:[{content:{parts:[{text:'world'}]},finishReason:'STOP'}]}]},
  {module:'openai',name:'callOpenAI',format:'sse',chunks:[{choices:[{index:0,delta:{content:'Hello ',reasoning_content:'private'}}]},{choices:[{index:0,delta:{content:'world'},finish_reason:'stop'}]}]},
  {module:'ollama',name:'callOllama',format:'ndjson',chunks:[{message:{content:'Hello ',thinking:'private'},done:false},{message:{content:'world'},done:true}]},
  {module:'openai_responses',name:'callOpenAIResponses',format:'sse',chunks:[{type:'response.output_text.delta',delta:'Hello '},{type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Hello '}]}]}}]}
 ];
 for(const entry of cases){
  const deltas=[];
  t.mock.method(global,'fetch',async()=>({ok:true,headers:new Headers({'content-type':entry.format==='sse'?'text/event-stream':'application/x-ndjson'}),body:(async function*(){
   yield new TextEncoder().encode((entry.format==='sse'?'data: ':'')+JSON.stringify(entry.chunks[0])+(entry.format==='sse'?'\n\n':'\n'));
   assert.equal(deltas[0],'Hello ',entry.name+' must emit before final upstream chunk');
   yield new TextEncoder().encode((entry.format==='sse'?'data: ':'')+JSON.stringify(entry.chunks[1])+(entry.format==='sse'?'\n\n':'\n'));
  })()}));
  const result=await require('../src/backend/assistant/adapters/'+entry.module)[entry.name]({model:'test',baseUrl:'https://fixture.test',supportsStreaming:true},[{role:'user',content:'hi'}],[],null,{onAnswer:delta=>deltas.push(delta)});
  assert.equal(deltas.join(''),result.content);assert.ok(!deltas.includes('private'));
 }
});
