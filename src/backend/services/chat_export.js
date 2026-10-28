'use strict';
// Chat run export for error analysis: full JSON records or a flat CSV summary per channel.
const reader=require('./audit_reader');
const {toCsv}=require('../utils/export_safety');
const CHANNELS={all:'Tất cả kênh',embed:'Embed Chat',page:'Page Chat'};
const MAX_RUNS=5000;
const invalid=message=>Object.assign(new Error(message),{statusCode:400});
function channelOf(item) {
  const payload=item.requestPayload||{},endpoint=String(payload.endpoint||'');
  if(endpoint==='/api/embed/chat'||payload.embedId)return 'embed';
  if(endpoint.startsWith('/api/intelligent-core/chat')||endpoint==='/api/chat/attachments')return 'page';
  return 'other';
}
const isIssue=item=>String(item.status||'SUCCESS').toUpperCase()!=='SUCCESS'||item.feedback==='dislike';
const pad=value=>String(value).padStart(2,'0');
// Runs store the server's local time as "HH:mm:ss dd/mm/yyyy" (vi-VN); older runs may hold ISO text.
function dayOf(timestamp) {
  const text=String(timestamp||''),local=/(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if(local)return `${local[3]}-${pad(local[2])}-${pad(local[1])}`;
  const date=new Date(text);
  return Number.isNaN(date.getTime())?null:`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}
function dayRange(from,to) {
  for(const day of [from,to])if(day&&!/^\d{4}-\d{2}-\d{2}$/.test(day))throw invalid('Ngày lọc không hợp lệ.');
  if(from&&to&&from>to)throw invalid('"Từ ngày" phải trước hoặc bằng "Đến ngày".');
  return item=>{
    if(!from&&!to)return true;
    const day=dayOf(item.timestamp);
    return Boolean(day)&&(!from||day>=from)&&(!to||day<=to);
  };
}
async function runs(account,{channel='all',issuesOnly=false,limit=MAX_RUNS,from='',to=''}={}) {
  if(!CHANNELS[channel])throw invalid('Kênh chat không hợp lệ.');
  const size=Math.min(MAX_RUNS,Math.max(1,Number.parseInt(limit,10)||MAX_RUNS));
  const inRange=dayRange(from||'',to||'');
  const picked=(await reader.list(account)).filter(item=>(channel==='all'||channelOf(item)===channel)&&(!issuesOnly||isIssue(item))&&inRange(item)).slice(0,size);
  const feedback=new Map(picked.map(item=>[item.id,item.feedback||null]));
  const records=new Map((await reader.records(picked.map(item=>item.id))).map(item=>[item.id,item]));
  // List order is newest first; records come back in storage order, so keep the list's order.
  return picked.filter(item=>records.has(item.id)).map(item=>{
    const record=records.get(item.id);
    return {...record,channel:channelOf(record),feedback:feedback.get(item.id)};
  });
}
function row(run) {
  const p=run.requestPayload||{},usage=p.tokenUsage||{};
  return {
    'Mã lượt':run.id,'Thời gian':run.timestamp,'Kênh':CHANNELS[run.channel]||'Khác','Trạng thái':run.status,
    'Đánh giá':run.feedback==='like'?'Thích':run.feedback==='dislike'?'Không thích':'','Câu hỏi':run.question,
    'Lỗi':run.errorReason,'Mã lỗi':p.errorCode||'','Câu trả lời':run.replyText,'SQL':run.sqlQuery,
    'Model':run.modelName,'Nhà cung cấp':run.providerName,'Độ trễ (ms)':run.latencyMs,
    'Token vào':usage.inputTokens??'','Token ra':usage.outputTokens??'','Tổng token':usage.totalTokens??'',
    'Số lần gọi công cụ':Array.isArray(p.toolCalls)?p.toolCalls.length:'','Chế độ xử lý':p.executionMode||'',
    'Phiên':p.sessionId||'','Widget':p.embedId||'','Trang nhúng':p.origin||'','Endpoint':p.endpoint||''
  };
}
async function build(account,{channel='all',format='json',issuesOnly=false,limit,from='',to=''}={}) {
  if(!['json','csv'].includes(format))throw invalid('Định dạng xuất không hợp lệ.');
  const list=await runs(account,{channel,issuesOnly,limit,from,to});
  const period=from||to?`-${(from||'dau').replace(/-/g,'')}_${(to||'nay').replace(/-/g,'')}`:'';
  const name=`chat-${channel}${issuesOnly?'-loi':''}${period}-${new Date().toISOString().slice(0,19).replace(/[-:T]/g,'')}.${format}`;
  // An empty export still carries the header row so the file opens with its columns.
  if(format==='csv')return {name,contentType:'text/csv; charset=UTF-8',body:list.length?toCsv(list.map(row)):'﻿'+Object.keys(row({})).map(key=>`"${key}"`).join(',')};
  const document={exportedAt:new Date().toISOString(),channel,channelLabel:CHANNELS[channel],issuesOnly,from:from||null,to:to||null,count:list.length,runs:list};
  return {name,contentType:'application/json; charset=UTF-8',body:JSON.stringify(document,null,2)};
}
module.exports={CHANNELS,MAX_RUNS,channelOf,isIssue,dayOf,runs,row,build};
