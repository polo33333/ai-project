'use strict';
const http=require('node:http'),https=require('node:https');
const transient=new Set(['ECONNRESET','EPIPE','ERR_STREAM_PREMATURE_CLOSE']);
function canRetry(method,path){return method==='GET'||method==='POST'&&['/points/search','/points/query','/points/scroll','/points/count'].some(s=>path.endsWith(s));}
function once(url,method,payload,remaining,fresh){return new Promise((resolve,reject)=>{
 const transport=url.protocol==='https:'?https:http;
 let settled=false,req,timer;
 const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
 req=transport.request(url,{method,headers:{'Content-Type':'application/json'},...(fresh?{agent:false}:{})},res=>{
  let data='';
  res.on('data',chunk=>data+=chunk);
  res.on('aborted',()=>finish(Object.assign(new Error('Qdrant response ended before completion'),{code:'ECONNRESET'})));
  res.on('error',error=>finish(error));
  res.on('end',()=>{
   if(!res.complete)return finish(Object.assign(new Error('Incomplete Qdrant response'),{code:'ERR_STREAM_PREMATURE_CLOSE'}));
   try{const parsed=JSON.parse(data);if(res.statusCode>=200&&res.statusCode<300)finish(null,parsed);
    else finish(Object.assign(new Error(parsed.status?.error||`Qdrant HTTP ${res.statusCode}`),{code:'QDRANT_HTTP_ERROR',statusCode:res.statusCode}));
   }catch(error){finish(error);}
  });
 });
 timer=setTimeout(()=>{const error=Object.assign(new Error('Qdrant request deadline exceeded'),{code:'QDRANT_TIMEOUT'});finish(error);req.destroy(error);},remaining);
 req.on('error',error=>finish(error));
 req.end(payload);
});}
async function requestJson(url,{method='GET',body=null,timeoutMs=10000}={}){
 const target=new URL(url);method=method.toUpperCase();
 const duration=Number.isFinite(Number(timeoutMs))&&Number(timeoutMs)>0?Math.min(Number(timeoutMs),120000):10000;
 const deadline=Date.now()+duration,payload=body===null?undefined:JSON.stringify(body);
 for(let attempt=0;attempt<2;attempt++){
  try{return await once(target,method,payload,Math.max(1,deadline-Date.now()),attempt>0);}
  catch(error){
   if(attempt===0&&transient.has(error.code)&&canRetry(method,target.pathname)&&Date.now()<deadline)continue;
   error.message=`Qdrant ${method} ${target.pathname}: ${error.message}`;
   throw error;
  }
 }
}
module.exports={requestJson};
