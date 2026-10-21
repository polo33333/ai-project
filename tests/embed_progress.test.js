'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function parser() {
  const source = fs.readFileSync('src/frontend/embed/knowledgehub-chat.js', 'utf8');
  const start = source.indexOf('  async function readChatResponse(');
  const end = source.indexOf('  function addAnswerActions(', start);
  const context = vm.createContext({ TextDecoder, Uint8Array, window: {} });
  vm.runInContext(fs.readFileSync('src/frontend/embed/chat-stream.js', 'utf8'), context);
  context.streamApi = async () => context.window.ChatStream;
  vm.runInContext(source.slice(start, end), context);
  return context.readChatResponse;
}
test('embed renders UTF-8 progress from fragmented SSE and returns the final result', async () => {
  const bytes = new TextEncoder().encode('event: progress\r\ndata: {"label":"Đang tra cứu dữ liệu"}\r\n\r\nevent: result\r\ndata: {"status":"success","reply":"Hoàn thành"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (let i=0;i<bytes.length;i+=3) controller.enqueue(bytes.slice(i,i+3));controller.close(); } });
  const progress = [];
  const result = await parser()(new Response(stream,{headers:{'Content-Type':'text/event-stream'}}), event => progress.push(event.label));
  assert.deepEqual(progress,['Đang tra cứu dữ liệu']);assert.equal(result.reply,'Hoàn thành');
});
test('embed supports older JSON backends and rejects interrupted/error streams', async () => {
  const read = parser();
  assert.equal((await read(new Response('{"status":"success"}',{headers:{'Content-Type':'application/json'}}),()=>{})).status,'success');
  await assert.rejects(read(new Response('event: progress\ndata: {"label":"Starting"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),()=>{}),/Stream kết thúc mà không có câu trả lời cuối/);
  await assert.rejects(read(new Response('event: error\ndata: {"message":"Denied"}\n\n',{headers:{'Content-Type':'text/event-stream'}}),()=>{}),/Denied/);
});

test('embed preserves partial coverage identically over JSON and fragmented SSE', async () => {
  const payload = { status: 'success', completionStatus: 'PARTIAL',
    reply: '| Mã | Địa chỉ |\n| --- | --- |\n| A | Chưa truy vấn |',
    answerEnvelope: { schemaVersion: '1', disposition: 'partial', requestAssessment: {
      schemaVersion: '1', complete: false, fields: [{ name: 'Địa chỉ', status: 'not_queried' }],
      failures: ['CONTRACT_FIELDS_NOT_QUERIED'], assurance: 'structured_criteria_only'
    } } };
  const read = parser();
  const json = await read(new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }), () => {});
  const bytes = new TextEncoder().encode(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
  const stream = new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } });
  const sse = await read(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), () => {});
  assert.equal(JSON.stringify(sse), JSON.stringify(json));
  assert.equal(sse.answerEnvelope.requestAssessment.complete, false);
  assert.equal(sse.completionStatus, 'PARTIAL');
  assert.ok(sse.reply.includes('Chưa truy vấn'));
});

test('embed answer icons sit outside the bubble, copy the answer and retry the paired question', async () => {
  const source = fs.readFileSync('src/frontend/embed/knowledgehub-chat.js', 'utf8');
  const copy = {}, retry = {}, calls = [];
  const actions = { setAttribute() {}, querySelectorAll: () => [copy, retry] };
  const context = vm.createContext({
    document: { createElement: () => actions },
    navigator: { clipboard: { writeText: async text => calls.push(['copy', text]) } },
    activeRequest: null, input: { disabled: false }, followMessages: false, setTimeout() {},
    submitEmbedQuestion: async (question, isRetry) => calls.push(['retry', question, isRetry])
  });
  const start = source.indexOf('  function addAnswerActions(');
  vm.runInContext(source.slice(start, source.indexOf('  async function submitEmbedQuestion(', start)), context);
  let sibling;
  const node = { after: value => { sibling = value; }, cloneNode: () => ({ querySelectorAll: () => [], textContent: 'Displayed answer' }) };
  context.addAnswerActions(node, 'Original question', 'Plain answer');
  assert.equal(sibling, actions);
  assert.match(actions.innerHTML, /Sao chép câu trả lời/);
  assert.match(actions.innerHTML, /<svg/);
  await copy.onclick();
  await retry.onclick();
  assert.deepEqual(calls, [['copy', 'Plain answer'], ['retry', 'Original question', true]]);
  assert.equal(retry.disabled, false);
  context.activeRequest = {};
  await retry.onclick();
  assert.equal(calls.length, 2);
});
