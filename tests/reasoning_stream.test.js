'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callOllama } = require('../src/backend/intelligent_core/adapters/ollama');
const { callOpenAI } = require('../src/backend/intelligent_core/adapters/openai');
const { dispatchToProvider } = require('../src/backend/intelligent_core/adapters');
const { callGemini } = require('../src/backend/intelligent_core/adapters/gemini');
function streamed(values, sse = false) {
  const text = values.map(value => sse ? `data: ${JSON.stringify(value)}\r\n\r\n` : JSON.stringify(value) + '\n').join('');
  const bytes = Buffer.from(text);
  return { ok: true, headers: new Headers({ 'content-type': sse ? 'text/event-stream' : 'application/x-ndjson' }), body: (async function* () { for(let i=0;i<bytes.length;i+=3) yield bytes.subarray(i,i+3); })() };
}
test('Ollama streams reasoning before answer and preserves tools and usage', async t => {
  const events=[];let body;
  t.mock.method(global,'fetch',async (_,opts)=>{body=JSON.parse(opts.body); return streamed([
    {message:{thinking:'Đang xem'}}, {message:{thinking:' dữ liệu'}},
    {message:{content:'ok',tool_calls:[{function:{name:'lookup',arguments:{id:1}}}]}},
    {done:true,done_reason:'stop',prompt_eval_count:4,eval_count:6}
  ]);});
  const result=await callOllama({baseUrl:'http://test',model:'test'},[],[],null,{onReasoning:delta=>events.push(delta)});
  assert.equal(body.stream,true);assert.equal(body.think,undefined);
  assert.equal(events.join(''),'Đang xem dữ liệu');assert.equal(result.content,'ok');
  assert.equal(result.tool_calls[0].function.arguments.id,1);assert.equal(result.usage.totalTokens,10);
});
test('compat stream merges fragmented tool arguments and keeps reasoning out of answer',async t=>{
  const events=[];
  t.mock.method(global,'fetch',async()=>streamed([
    {choices:[{index:0,delta:{reasoning_content:'Kiểm tra'}}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'c1',function:{name:'lookup',arguments:'{"id":'}}]}}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}
  ],true));
  const result=await callOpenAI({baseUrl:'http://test'},[],[],null,{onReasoning:delta=>events.push(delta)});
  assert.deepEqual(events,['Kiểm tra']);assert.equal(result.content,null);
  assert.equal(result.tool_calls[0].function.arguments,'{"id":1}');assert.equal(result.usage.totalTokens,5);
});
test('model without reasoning completes normally without reasoning events',async t=>{
 const events=[];
 t.mock.method(global,'fetch',async()=>streamed([{choices:[{delta:{content:'answer'},finish_reason:'stop'}]}],true));
 const result=await callOpenAI({baseUrl:'http://test'},[],[],null,{onReasoning:d=>events.push(d)});
 assert.equal(result.content,'answer');assert.deepEqual(events,[]);
});
test('truncated provider stream is rejected',async t=>{
 t.mock.method(global,'fetch',async()=>streamed([{choices:[{delta:{content:'partial'}}]}],true));
 await assert.rejects(callOpenAI({baseUrl:'http://test'},[],[],null,{onReasoning:()=>{}}),/before completion/);
});
test('official OpenAI uses Responses summary stream and converts tool output',async t=>{
 let request;const events=[];
 t.mock.method(global,'fetch',async(url,opts)=>{request={url,body:JSON.parse(opts.body)};return streamed([
 {type:'response.reasoning_summary_text.delta',delta:'Summary'},
 {type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Answer'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}}}
 ],true);});
 const result=await dispatchToProvider({baseUrl:'https://api.openai.com/v1',model:'gpt-5'},[{role:'tool',tool_call_id:'call1',content:'result'}],[],null,{onReasoning:d=>events.push(d)});
 assert.equal(request.url,'https://api.openai.com/v1/responses');assert.equal(request.body.reasoning.summary,'auto');
 assert.equal(request.body.input[0].type,'function_call_output');assert.deepEqual(events,['Summary']);assert.equal(result.content,'Answer');
});
test('Gemini thought summaries stream separately and preserve signatures',async t=>{
 let body;const events=[];
 t.mock.method(global,'fetch',async(_,opts)=>{body=JSON.parse(opts.body);return streamed([
 {candidates:[{content:{parts:[{thought:true,text:'Summary'}]}}]},
 {candidates:[{content:{parts:[{functionCall:{name:'lookup',args:{id:1}},thoughtSignature:'signed'}]},finishReason:'STOP'}]}
 ],true);});
 const result=await callGemini({baseUrl:'http://test',model:'gemini-2.5-pro'},[],[],null,{onReasoning:d=>events.push(d)});
 assert.equal(body.generationConfig.thinkingConfig.includeThoughts,true);assert.deepEqual(events,['Summary']);assert.equal(result.content,null);
 assert.equal(result.rawParts[1].thoughtSignature,'signed');
});

test('reasoning callback runs before the provider finishes generation', async t => {
  const events = [];
  t.mock.method(global, 'fetch', async () => ({ ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: (async function* () {
      yield Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"first"}}]}\n\n');
      assert.deepEqual(events, ['first']);
      yield Buffer.from('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
    })()
  }));
  await callOpenAI({ baseUrl: 'http://test' }, [], [], null, { onReasoning: d => events.push(d) });
});

test('endpoint rejecting streaming retries JSON without changing the selected model', async t => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (_, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) return new Response('{"error":{"message":"streaming not supported"}}', { status: 400 });
    return new Response('{"choices":[{"message":{"content":"answer"},"finish_reason":"stop"}]}', { headers: { 'content-type': 'application/json' } });
  });
  const result = await callOpenAI({ baseUrl: 'http://test', model: 'same-model' }, [], [], null, { onReasoning: () => {} });
  assert.equal(result.content, 'answer');
  assert.equal(bodies[0].stream, true); assert.equal(bodies[1].stream, undefined);
  assert.equal(bodies[1].model, 'same-model');
});

test('Gemini 3 streaming requests thinking while routing JSON without streaming stays unchanged', async t => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) };
  });
  const provider = { baseUrl: 'http://test', model: 'gemini-3.5-flash-lite' };
  await callGemini(provider, [], [], null, { onReasoning: () => {} });
  await callGemini({ ...provider, thinkingLevel: 'minimal' }, [], [], null, { onReasoning: () => {} });
  await callGemini({ ...provider, responseFormat: 'json' }, [], [], null);
  assert.equal(bodies[0].generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
  assert.equal(bodies[1].generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
  assert.equal(bodies[2].generationConfig.thinkingConfig, undefined);
});

test('Gemini 2.5 Lite uses thinking budget rather than Gemini 3 thinking level', async t => {
  let body;
  t.mock.method(global, 'fetch', async (_, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) };
  });
  await callGemini({ baseUrl: 'http://test', model: 'gemini-2.5-flash-lite', thinkingBudget: 0 }, [], [], null, { onReasoning: () => {} });
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, undefined);
});
