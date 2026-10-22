'use strict';
const security=require('../intelligent_core/security_guard');
const {randomUUID}=require('node:crypto');

// Only an explicit public answer for an eligible general request may stream.
// Retain an unfinished word so masking sees complete secret/token values.
function createAnswerStream(callback,{signal,enabled=process.env.CHAT_ANSWER_STREAMING_ENABLED!=='false',now=Date.now}={}) {
 const started=now(),metrics={enabled:Boolean(enabled&&typeof callback==='function'),firstAnswerMs:null,verifiedAnswerMs:null,deltaEvents:0};
 let current=null;
 function send(type,data={}){if(!metrics.enabled||signal?.aborted)return;callback({type,...data});}
 function reset(){if(current)send('answer_reset',{id:current.id});current=null;}
 function begin(eligible){
  reset();
  if(!metrics.enabled||!eligible)return {push(){},cancel(){}};
  const state={id:randomUUID(),raw:'',visible:'',sent:0,seq:0,opened:false};current=state;
  return {cancel(){state.blocked=true;if(current===state)reset();},push(delta){
   if(current!==state||signal?.aborted||typeof delta!=='string')return;
   if(state.blocked)return;
   if(state.raw.length+delta.length>256000){state.blocked=true;return;}
   state.raw+=delta;
   const opening=state.raw.indexOf('<final_answer>');if(opening<0||state.raw.slice(0,opening).trim())return;
   let body=state.raw.slice(opening+'<final_answer>'.length).trimStart();
   const closing=body.indexOf('</final_answer>');if(closing>=0)body=body.slice(0,closing);
   if(body.includes('<')||['{','['].includes(body.trimStart()[0]))return;
   const boundary=Math.max(body.lastIndexOf(' '),body.lastIndexOf('\n'),body.lastIndexOf('\t'));if(boundary<state.sent)return;
   const end=boundary+1,safe=security.maskSensitiveData(body.slice(0,end));
   if(!state.opened&&!safe.trim())return;
   if(!safe.startsWith(state.visible)){send('answer_reset',{id:state.id});state.blocked=true;return;}
   const paragraph=safe.slice(state.visible.length);state.visible=safe;state.sent=end;if(!paragraph)return;
   if(!state.opened){send('answer_start',{id:state.id,verified:false});state.opened=true;}
   metrics.firstAnswerMs??=now()-started;metrics.deltaEvents++;
   send('answer_delta',{id:state.id,seq:++state.seq,delta:paragraph});
  }};
 }
 function commit(result){
  if(!metrics.enabled||!result.success||result.completionStatus!=='SUCCESS'||!result.replyText||result.replyText.length>256000){reset();return;}
  metrics.verifiedAnswerMs=now()-started;
  const finalText=security.maskSensitiveData(result.replyText);
  // Keep an already visible prefix in place when verification confirms it.
  if(current?.opened&&(finalText.startsWith(current.visible)||finalText===current.visible.trimEnd())){
   const delta=finalText.slice(current.visible.length);
   if(delta){metrics.deltaEvents++;send('answer_delta',{id:current.id,seq:++current.seq,delta});}
   current.visible=finalText;return;
  }
  reset();
  // Verified Markdown tables can reveal progressively through the rich preview.
  // Keep raw code/JSON and HTML blocks for the canonical final renderer.
  const lines=finalText.split('\n');
  const structured=lines.findIndex(line=>{
   const value=line.trimStart();
   return ['```','~~~','<','{','['].some(prefix=>value.startsWith(prefix));
  });
  const introduction=(structured<0?finalText:lines.slice(0,structured).join('\n')).trimEnd();
  if(!introduction.trim())return;
  const id=randomUUID();current={id};send('answer_start',{id,verified:true,animate:true});
  const points=Array.from(introduction);
  for(let offset=0,seq=0;offset<points.length;offset+=2048){metrics.firstAnswerMs??=now()-started;metrics.deltaEvents++;send('answer_delta',{id,seq:++seq,delta:points.slice(offset,offset+2048).join('')});}
 }
 return {begin,reset,commit,metrics};
}
module.exports={createAnswerStream};
