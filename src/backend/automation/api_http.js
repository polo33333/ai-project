'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const crypto = require('node:crypto');
const { ensure, error, resolve, get } = require('./contract');
const MAX_BYTES = 2 * 1024 * 1024;
const METHODS = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
const FORMATS = ['none','json','text','form','multipart','binary'];
const RESPONSES = ['json','text','binary','auto'];
const refs = /\{\{\s*([\w.-]+)\s*\}\}/g;
function allowedOrigin(url) { return String(process.env.WORKFLOW_API_ALLOWED_ORIGINS || '').split(',').map(value=>value.trim()).includes(url.origin); }
function apiUrl(value, state) {
  ensure(typeof value === 'string' && value, 'API cần URL HTTP/HTTPS.');
  const neutral = value.replace(refs,'__workflow_value__'); let url;
  try { url = new URL(neutral); } catch (_) { throw error('API cần URL HTTP/HTTPS hợp lệ.'); }
  ensure(!url.origin.includes('__workflow_value__') && !url.username && !url.password && !url.hash && ['http:','https:'].includes(url.protocol), 'Origin API phải cố định, không chứa thông tin đăng nhập.');
  const permitted = allowedOrigin(url), host=url.hostname.replace(/^\[|\]$/g,'');
  ensure(url.protocol==='https:' || permitted, 'API HTTP cần origin được quản trị viên cho phép.');
  ensure(permitted || (host!=='localhost' && (!require('node:net').isIP(host) || require('./data_sources').publicAddress(host))), 'API nội bộ cần origin được quản trị viên cho phép.');
  if(state) {
    const rendered=value.replace(refs,(_,reference)=>{const result=get(state,reference);ensure(result!==undefined && result!==null && ['string','number','boolean'].includes(typeof result) && !['.','..'].includes(String(result)),'Tham chiếu đường dẫn API cần giá trị đơn hợp lệ.');return encodeURIComponent(String(result));});
    url=new URL(rendered);ensure(url.origin===new URL(neutral).origin,'Không được thay đổi origin API bằng dữ liệu đầu vào.');
  }
  return url;
}
function validateApi(binding) {
  apiUrl(binding.url);
  ensure(METHODS.includes(binding.method || 'GET'),'Phương thức API chưa được hỗ trợ.');
  ensure(FORMATS.includes(binding.bodyFormat || (binding.body===undefined?'none':'json')),'Định dạng body không hợp lệ.');
  ensure(RESPONSES.includes(binding.responseFormat || 'json'),'Định dạng phản hồi không hợp lệ.');
  ensure(!['GET','HEAD'].includes(binding.method || 'GET') || (binding.bodyFormat || (binding.body===undefined?'none':'json'))==='none','GET/HEAD không dùng body.');
  for(const key of ['query','headers'])ensure(!binding[key] || (typeof binding[key]==='object' && !Array.isArray(binding[key])),`${key} cần nhóm trường.`);
  ensure(!binding.dataPath || typeof binding.dataPath==='string','Đường dẫn JSON cần chuỗi.');
  ensure(binding.timeoutMs===undefined || (Number.isInteger(binding.timeoutMs) && binding.timeoutMs>=1000 && binding.timeoutMs<=60000),'Thời gian API cần 1.000–60.000 ms.');
  ensure(binding.maxRedirects===undefined || (Number.isInteger(binding.maxRedirects) && binding.maxRedirects>=0 && binding.maxRedirects<=5),'Số redirect cần 0–5.');
  const auth=binding.auth || {type:'none'};
  ensure(['none','bearer','basic','apiKey'].includes(auth.type || 'none'),'Loại xác thực API không hợp lệ.');
  for(const key of ['tokenEnv','passwordEnv','valueEnv','usernameEnv'])if(auth[key])ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(auth[key]),'Tên biến môi trường của credential không hợp lệ.');
  if(auth.type==='bearer')ensure(auth.tokenEnv || /^\{\{[\w. -]+\}\}$/.test(auth.token || ''),'Bearer cần biến môi trường hoặc token từ bước trước.');
  if(auth.type==='basic')ensure((auth.username!==undefined || auth.usernameEnv) && auth.passwordEnv,'Basic cần tên đăng nhập và biến môi trường mật khẩu.');
  if(auth.type==='apiKey')ensure(auth.name && auth.valueEnv && ['header','query'].includes(auth.location || 'header'),'API key cần tên, biến môi trường và vị trí gửi.');
  return binding;
}
function envValue(name) { ensure(name && process.env[name]!==undefined && process.env[name]!=='',`Credential chưa được cấu hình (${name || 'chưa chọn biến môi trường'}).`);return process.env[name]; }
function headerValue(value,state) { return value && typeof value==='object' && value.env ? envValue(value.env) : resolve(value,state); }
function setHeader(headers,name,value) {
  ensure(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) && !['host','connection','content-length','transfer-encoding','proxy-authorization','proxy-connection','upgrade','accept-encoding'].includes(name.toLowerCase()),'Header API không hợp lệ.');
  ensure(value!==undefined && value!==null && !/[\r\n]/.test(String(value)),'Giá trị header API không hợp lệ.');headers[name.toLowerCase()]=String(value);
}
async function requestBody(binding,state) {
  const format=binding.bodyFormat || (binding.body===undefined?'none':'json');
  if(format==='none')return {buffer:null};
  const value=resolve(binding.body,state);ensure(value!==undefined,'Body API thiếu dữ liệu.');
  if(format==='json')return {buffer:Buffer.from(JSON.stringify(value)),contentType:'application/json'};
  if(format==='text'){ensure(typeof value==='string','Body văn bản cần chuỗi.');return {buffer:Buffer.from(value),contentType:'text/plain; charset=utf-8'};}
  if(format==='binary'){const {buffer,document}=await require('./data_sources').readLibraryBuffer(typeof value==='object'?value.documentId:value);return {buffer,contentType:document.mimeType || 'application/octet-stream'};}
  ensure(value && typeof value==='object' && !Array.isArray(value),'Body form cần nhóm trường.');
  if(format==='form'){const form=new URLSearchParams();for(const [key,item] of Object.entries(value)){ensure(item!==undefined && item!==null && ['string','number','boolean'].includes(typeof item),'Giá trị form cần dữ liệu đơn.');form.append(key,String(item));}return {buffer:Buffer.from(form.toString()),contentType:'application/x-www-form-urlencoded'};}
  const boundary=`workflow-${crypto.randomBytes(16).toString('hex')}`,chunks=[];
  const quoted=value=>String(value).replace(/[\r\n"\\]/g,'_');
  for(const [key,item] of Object.entries(value)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(key)}"`));
    if(item && typeof item==='object' && item.documentId) {
      const {buffer,document}=await require('./data_sources').readLibraryBuffer(item.documentId);
      chunks.push(Buffer.from(`; filename="${quoted(item.filename || document.filename || document.title || 'file')}"\r\nContent-Type: application/octet-stream\r\n\r\n`),buffer,Buffer.from('\r\n'));
    } else {ensure(item!==undefined && item!==null && ['string','number','boolean'].includes(typeof item),'Mục multipart cần giá trị đơn hoặc file Thư viện.');chunks.push(Buffer.from(`\r\n\r\n${String(item)}\r\n`));}
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));return {buffer:Buffer.concat(chunks),contentType:`multipart/form-data; boundary=${boundary}`};
}
async function readApi(binding,state,signal) {
  validateApi(binding);const url=apiUrl(binding.url,state),method=binding.method || 'GET',headers={accept:'application/json'};
  for(const [key,value] of Object.entries(resolve(binding.query || {},state))) {
    const values=Array.isArray(value)?value:[value];url.searchParams.delete(key);values.forEach(item=>{ensure(item!==undefined && item!==null && ['string','number','boolean'].includes(typeof item),`Tham số API ${key} cần giá trị đơn.`);url.searchParams.append(key,String(item));});
  }
  for(const [name,value] of Object.entries(binding.headers || {}))setHeader(headers,name,headerValue(value,state));
  const auth=binding.auth || {};
  if(auth.type==='bearer'){const token=auth.tokenEnv?envValue(auth.tokenEnv):resolve(auth.token,state);ensure(typeof token==='string' && token.trim(),'Token API cần chuỗi có giá trị.');setHeader(headers,'authorization',`Bearer ${token}`);}
  if(auth.type==='basic'){const username=auth.usernameEnv?envValue(auth.usernameEnv):resolve(auth.username,state);ensure(typeof username==='string' && !username.includes(':'),'Tên đăng nhập Basic không hợp lệ.');setHeader(headers,'authorization',`Basic ${Buffer.from(`${username}:${envValue(auth.passwordEnv)}`).toString('base64')}`);}
  if(auth.type==='apiKey'){const value=envValue(auth.valueEnv);if(auth.location==='query')url.searchParams.set(auth.name,value);else setHeader(headers,auth.name,value);}
  const body=await requestBody(binding,state);ensure(!body.buffer || body.buffer.length<=MAX_BYTES,'Body API vượt quá 2 MB.');
  ensure(!['GET','HEAD'].includes(method) || !body.buffer,'GET/HEAD không dùng body.');
  if(body.contentType && !headers['content-type'])headers['content-type']=body.contentType;
  if(body.buffer)headers['content-length']=String(body.buffer.length);
  ensure(Buffer.byteLength(JSON.stringify(headers))<=64*1024,'Header API quá lớn.');
  let current=url,currentMethod=method,currentBody=body.buffer,currentHeaders=headers;
  const deadline=Date.now()+(binding.timeoutMs || 30000);
  for(let redirects=0;;redirects++) {
    ensure(deadline>Date.now(),'API hết thời gian chờ.');
    const response=await perform(current,currentMethod,currentHeaders,currentBody,signal,deadline-Date.now());
    if([301,302,303,307,308].includes(response.status) && response.headers.location) {
      ensure(redirects<(binding.maxRedirects || 0),`API trả HTTP ${response.status}: vượt quá số redirect được cho phép.`);
      const next=apiUrl(new URL(response.headers.location,current).href);
      ensure(next.origin===current.origin,'Redirect khác origin không được phép.');
      if((response.status===303 && currentMethod!=='HEAD') || ([301,302].includes(response.status) && currentMethod==='POST')){currentMethod='GET';currentBody=null;currentHeaders={...currentHeaders};delete currentHeaders['content-type'];delete currentHeaders['content-length'];}
      current=next;continue;
    }
    if(response.status<200 || response.status>=300)throw Object.assign(error(`API trả HTTP ${response.status}.`),{apiRequestStarted:true});
    const contentType=String(response.headers['content-type'] || '');
    let format=binding.responseFormat || 'json';if(format==='auto')format=/json/i.test(contentType)?'json':/^(text\/|application\/(xml|javascript))/i.test(contentType)?'text':'binary';
    let data=null,binary;
    if(response.buffer.length && currentMethod!=='HEAD') {
      if(format==='json'){try{data=JSON.parse(response.buffer.toString('utf8'));}catch(_){throw Object.assign(error('API không trả dữ liệu JSON hợp lệ.'),{apiRequestStarted:true});}}
      else if(format==='text')data=response.buffer.toString('utf8');
      else { const filename=binding.filename || /filename="?([^";]+)"?/i.exec(String(response.headers['content-disposition'] || ''))?.[1] || 'api-response.bin';binary={buffer:response.buffer,filename,contentType:contentType || 'application/octet-stream'}; }
    }
    if(binding.dataPath && data!==null)data=get(data,binding.dataPath);
    const responseHeaders=Object.fromEntries(Object.entries(response.headers).filter(([name])=>!['set-cookie','authorization','proxy-authorization'].includes(name.toLowerCase())));
    return {data,binary,response:{status:response.status,headers:responseHeaders}};
  }
}
function perform(url,method,headers,body,signal,timeout) {
  return new Promise((done,reject)=>{
    const transport=url.protocol==='https:'?https:http;
    let alarm;
    const options={method,headers,signal,timeout,lookup(host,options,callback){dns.lookup(host,{all:true},(failure,addresses)=>{if(failure)return callback(failure);if(!addresses.length || (!allowedOrigin(url) && addresses.some(item=>!require('./data_sources').publicAddress(item.address))))return callback(error('API nội bộ cần origin được quản trị viên cho phép.'));callback(null,...(options.all?[addresses]:[addresses[0].address,addresses[0].family]));});}};
    const receive=response=>{
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>MAX_BYTES)request.destroy(error('Dữ liệu API vượt quá 2 MB.'));else chunks.push(buffer);});
      response.on('error',failure=>{clearTimeout(alarm);reject(Object.assign(failure,{apiRequestStarted:true}));});response.on('aborted',()=>{clearTimeout(alarm);reject(Object.assign(error('API ngắt kết nối khi trả dữ liệu.'),{apiRequestStarted:true}));});
      response.on('end',()=>{clearTimeout(alarm);done({status:response.statusCode,headers:response.headers || {},buffer:Buffer.concat(chunks)});});
    };
    const request=method==='GET' && !body?transport.get(url,options,receive):transport.request(url,options,receive);
    alarm=setTimeout(()=>request.destroy(error('API hết thời gian chờ.')),timeout);
    request.on('timeout',()=>request.destroy(error('API hết thời gian chờ.')));request.on('error',failure=>{clearTimeout(alarm);reject(Object.assign(failure,{apiRequestStarted:true}));});request.on('close',()=>clearTimeout(alarm));
    if(method!=='GET' || body)request.end(body || undefined);
  });
}
function hasWriteEffect(binding) { return binding && binding.type==='api' && !['GET','HEAD','OPTIONS'].includes(binding.method || 'GET'); }
module.exports={apiUrl,validateApi,readApi,hasWriteEffect,requestBody,METHODS,FORMATS,RESPONSES};
