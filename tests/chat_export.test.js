'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const reader=require('../src/backend/services/audit_reader');
const exporter=require('../src/backend/services/chat_export');
const {requestStores}=require('../src/backend/storage/request_stores');
const runs=[
  {id:'e1',timestamp:'09:05:01 28/10/2026',status:'ERROR',question:'=HYPERLINK("x")',errorReason:'Timeout',requestPayload:{endpoint:'/api/embed/chat',embedId:'w1',errorCode:'TIMEOUT',tokenUsage:{inputTokens:3,outputTokens:1,totalTokens:4}}},
  {id:'p1',timestamp:'23:59:59 27/10/2026',status:'SUCCESS',question:'Doanh thu',requestPayload:{endpoint:'/api/intelligent-core/chat/stream',toolCalls:[{name:'sql'},{name:'chart'}]}},
  {id:'p2',timestamp:'00:00:00 1/10/2026',status:'SUCCESS',question:'Hợp đồng',requestPayload:{endpoint:'/api/chat/attachments'}},
  {id:'a1',timestamp:'',status:'PARTIAL',question:'API',requestPayload:{endpoint:'/api/v1/chat/completions'}}
];
function mockReader(t) {
  const lightweight=runs.map(run=>({id:run.id,timestamp:run.timestamp,status:run.status,question:run.question,feedback:run.id==='p2'?'dislike':null,requestPayload:{endpoint:run.requestPayload.endpoint,embedId:run.requestPayload.embedId}}));
  const asked=[];
  t.mock.method(reader,'list',async()=>lightweight);
  // Storage order differs from list order; the export must keep the newest-first list order.
  t.mock.method(reader,'records',async ids=>{asked.push(ids);return runs.filter(run=>ids.includes(run.id)).reverse().map(run=>structuredClone(run));});
  return asked;
}
test('export filters each channel and keeps full diagnostics in JSON',async t=>{
  mockReader(t);
  const account={id:'admin',role:'admin'};
  assert.deepEqual((await exporter.runs(account,{channel:'embed'})).map(run=>run.id),['e1']);
  assert.deepEqual((await exporter.runs(account,{channel:'page'})).map(run=>run.id),['p1','p2']);
  assert.deepEqual((await exporter.runs(account,{channel:'all'})).map(run=>run.id),['e1','p1','p2','a1']);
  const file=await exporter.build(account,{channel:'page',format:'json'});
  const document=JSON.parse(file.body);
  assert.equal(document.count,2);assert.equal(document.runs[0].requestPayload.toolCalls.length,2);
  assert.equal(document.runs[1].feedback,'dislike');assert.equal(document.runs[1].channel,'page');
  assert.match(file.name,/^chat-page-\d{14}\.json$/);
});
test('issues-only export keeps errors, partial answers and disliked turns, then applies the limit',async t=>{
  const asked=mockReader(t);
  const account={id:'admin',role:'admin'};
  assert.deepEqual((await exporter.runs(account,{issuesOnly:true})).map(run=>run.id),['e1','p2','a1']);
  assert.deepEqual((await exporter.runs(account,{issuesOnly:true,limit:'2'})).map(run=>run.id),['e1','p2']);
  // Only the selected runs are read in full.
  assert.deepEqual(asked.at(-1),['e1','p2']);
});
test('CSV export is a flat Excel-safe summary',async t=>{
  mockReader(t);
  const file=await exporter.build({id:'admin',role:'admin'},{channel:'embed',format:'csv',issuesOnly:true});
  assert.equal(file.contentType,'text/csv; charset=UTF-8');assert.ok(file.body.startsWith('﻿"Mã lượt"'));
  assert.match(file.body,/"'=HYPERLINK\(""x""\)"/);
  assert.match(file.body,/"Embed Chat","ERROR"/);assert.match(file.body,/"TIMEOUT"/);
  t.mock.method(reader,'list',async()=>[]);
  const empty=await exporter.build({id:'admin',role:'admin'},{format:'csv'});
  assert.equal(empty.body.split('\n').length,1);assert.match(empty.body,/"Endpoint"$/);
});
test('export rejects unknown channels and formats and reads no full stores',async()=>{
  await assert.rejects(exporter.build({id:'admin',role:'admin'},{channel:'sms'}),error=>error.statusCode===400);
  await assert.rejects(exporter.build({id:'admin',role:'admin'},{format:'xml'}),error=>error.statusCode===400);
  const files=requestStores({method:'GET',url:'/api/chat-history/export?channel=embed&format=csv'});
  assert.ok(!files.includes('chat_history.json'));assert.ok(files.includes('accounts.json'));
});
test('date range keeps runs whose local day falls inside both ends',async t=>{
  mockReader(t);
  const account={id:'admin',role:'admin'};
  assert.equal(exporter.dayOf('09:05:01 28/10/2026'),'2026-10-28');assert.equal(exporter.dayOf('00:00:00 1/10/2026'),'2026-10-01');
  assert.equal(exporter.dayOf(''),null);
  assert.deepEqual((await exporter.runs(account,{from:'2026-10-27',to:'2026-10-28'})).map(run=>run.id),['e1','p1']);
  assert.deepEqual((await exporter.runs(account,{from:'2026-10-28'})).map(run=>run.id),['e1']);
  assert.deepEqual((await exporter.runs(account,{to:'2026-10-27'})).map(run=>run.id),['p1','p2']);
  const file=await exporter.build(account,{format:'json',from:'2026-10-01',to:'2026-10-27'});
  const document=JSON.parse(file.body);
  assert.equal(document.from,'2026-10-01');assert.equal(document.count,2);assert.match(file.name,/^chat-all-20261001_20261027-\d{14}\.json$/);
  await assert.rejects(exporter.runs(account,{from:'2026-10-28',to:'2026-10-01'}),error=>error.statusCode===400);
  await assert.rejects(exporter.runs(account,{from:'28/10/2026'}),error=>error.statusCode===400);
});
