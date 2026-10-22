(function(global){
 'use strict';
 const followers=new WeakMap();
 const workflowSubmissions=new WeakMap();
 function beginWorkflowSubmission(node,form,submit,execution){
  if(workflowSubmissions.has(node))return null;
  const controls=[...new Set([...form.querySelectorAll('input,select,textarea,button'),submit])];
  const disabled=controls.map(control=>control.disabled),label=submit.textContent;
  const message=document.createElement('p');message.className='workflow-submit-status';message.setAttribute('role','status');
  message.style.cssText='margin:10px 0 0;font-size:12px;line-height:1.6;color:inherit;';
  message.textContent='Đang gửi thông tin và tiếp tục xử lý…';form.appendChild(message);
  controls.forEach(control=>{control.disabled=true;});submit.textContent='Đang xử lý…';node.setAttribute('aria-busy','true');
  let awaiting=true,revision=execution.revision;
  const state={received(){awaiting=false;},release(){
   if(workflowSubmissions.get(node)!==state)return;
   workflowSubmissions.delete(node);controls.forEach((control,index)=>{control.disabled=disabled[index];});
   submit.textContent=label;message.remove();node.setAttribute('aria-busy','false');
  },hold(next){
   if(next.id!==execution.id)return false;
   if(next.revision<revision||(awaiting&&next.revision<=revision))return true;
   revision=next.revision;
   if(!['READY','QUEUED','RUNNING'].includes(next.status)){state.release();return false;}
   node.dataset.status=next.status;
   const badge=node.querySelector('.wp-execution-status,.kh-workflow-status');if(badge)badge.textContent='Đang xử lý';
   const step=next.steps?.find(item=>item.status==='RUNNING');
   message.textContent=step?.name?`Đang thực hiện: ${step.name}`:'Đã nhận thông tin. Đang tiếp tục xử lý…';
   return true;
  }};
  workflowSubmissions.set(node,state);return state;
 }
 function holdWorkflowUpdate(node,execution){return workflowSubmissions.get(node)?.hold(execution)||false;}
 function followResponse(scroller){
  if(!scroller)return null;
  const existing=followers.get(scroller);if(existing)return existing;
  let following=scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<64;
  let lastTop=scroller.scrollTop,lastHeight=scroller.scrollHeight,queued=false;
  const state={get following(){return following;},resume(){following=true;state.sync();},sync(){
   if(following)scroller.scrollTop=scroller.scrollHeight;
   lastTop=scroller.scrollTop;lastHeight=scroller.scrollHeight;
  }};
  const schedule=()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;state.sync();},24);};
  scroller.addEventListener('wheel',event=>{if(event.deltaY<0)following=false;},{passive:true});
  let touchY=null;
  scroller.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY ?? null;},{passive:true});
  scroller.addEventListener('touchmove',event=>{const y=event.touches[0]?.clientY;if(touchY!==null&&y>touchY)following=false;touchY=y ?? null;},{passive:true});
  scroller.addEventListener('scroll',()=>{
   const top=scroller.scrollTop,height=scroller.scrollHeight;
   if(height===lastHeight&&top<lastTop-2)following=false;
   if(height-scroller.clientHeight-top<64&&top>=lastTop)following=true;
   lastTop=top;lastHeight=height;
  },{passive:true});
  const resize=global.ResizeObserver?new global.ResizeObserver(schedule):null,observed=new Set();
  const observe=()=>{
   resize?.observe(scroller);
   const children=new Set(scroller.children);
   for(const child of observed)if(!children.has(child)){resize?.unobserve(child);observed.delete(child);}
   for(const child of children)if(!observed.has(child)){resize?.observe(child);observed.add(child);}
   schedule();
  };
  const mutation=global.MutationObserver?new global.MutationObserver(observe):null;
  mutation?.observe(scroller,{childList:true,subtree:true,characterData:true,attributes:true});
  observe();followers.set(scroller,state);return state;
 }
 async function read(response,{onProgress,onAnswer}={}){
  if(!response.ok){let message='HTTP '+response.status;try{message=(await response.json()).message||message;}catch{}throw new Error(message);}
  if(!response.headers.get('content-type')?.includes('text/event-stream'))return response.json();
  if(!response.body)throw new Error('Trình duyệt không hỗ trợ streaming response.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  try{
   for(;;){
    const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});
    // Normalize only after both bytes of CRLF have arrived.
    for(;;){
     const lf=buffer.indexOf('\n\n'),cr=buffer.indexOf('\r\n\r\n');
     const boundary=lf<0?cr:cr<0?lf:Math.min(lf,cr);if(boundary<0)break;
     if(boundary>8*1024*1024)throw new Error('Khung trả lời vượt giới hạn.');
     const crlf=buffer.slice(boundary,boundary+4)==='\r\n\r\n',frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+(crlf?4:2));
     let name='message';const lines=[];
     for(const line of frame.split('\n')){if(line.startsWith('event:'))name=line.slice(6).trim();if(line.startsWith('data:'))lines.push(line.slice(5).trimStart().trimEnd());}
     if(!lines.length)continue;const data=JSON.parse(lines.join('\n'));
     if(name==='error')throw new Error(data.message||'Không thể hoàn tất yêu cầu.');
     if(name==='final'||name==='result'){await onAnswer?.({type:'answer_complete'});return data;}
     if(name==='progress')onProgress?.(data);
     if(['answer_start','answer_delta','answer_reset'].includes(name))onAnswer?.({...data,type:name});
    }
    if(buffer.length>8*1024*1024)throw new Error('Khung trả lời vượt giới hạn.');
    if(done)throw new Error('Stream kết thúc mà không có câu trả lời cuối.');
   }
  }catch(error){onAnswer?.({type:'answer_reset'});throw error;}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 function createPreview(host,{renderMarkdown}={}){
  let id=null,seq=0,text='',shown=0,node=null,frame=null,disposed=false,live=false,deadline=null,finishResolve=null;
  function settle(){finishResolve?.();finishResolve=null;deadline=null;}
  function clear(){if(frame!==null)clearTimeout(frame);frame=null;settle();node?.remove();node=null;text='';shown=0;id=null;seq=0;host.classList.remove('has-answer-preview');}
  function schedule(){if(frame===null)frame=setTimeout(paint,24);}
  function paint(){
   frame=null;if(disposed||!node)return;
   const scroller=host.closest('#page-chat-messages-container,#chat-messages-container,.kh-embed-messages');
   const follow=scroller&&scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<64;
   const instant=!live||document.hidden||global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
   const ticks=deadline===null?12:Math.max(1,Math.ceil((deadline-Date.now())/24));
   shown=instant?text.length:Math.min(text.length,shown+Math.max(24,Math.ceil((text.length-shown)/ticks)));
   // Do not split a UTF-16 surrogate pair between paints.
   if(shown<text.length&&text.charCodeAt(shown-1)>=0xD800&&text.charCodeAt(shown-1)<=0xDBFF)shown++;
   const visible=text.slice(0,shown);
   if(typeof renderMarkdown==='function'){
    const previous=[...node.querySelectorAll('.chat-markdown-table-wrap,.kh-embed-table-wrap')].map(wrapper=>({left:wrapper.scrollLeft,widths:[...wrapper.querySelectorAll('col')].map(col=>parseFloat(col.style.width)||0)}));
    node.innerHTML=renderMarkdown(visible);
    node.querySelectorAll('.chat-markdown-table-wrap,.kh-embed-table-wrap').forEach((wrapper,index)=>{
     const prior=previous[index];if(!prior)return;
     let width=0;wrapper.querySelectorAll('col').forEach((col,column)=>{const size=Math.max(parseFloat(col.style.width)||0,prior.widths[column]||0);col.style.width=size+'px';width+=size;});
     wrapper.querySelector('table')?.style.setProperty('--chat-table-width',width+'px');wrapper.scrollLeft=prior.left;
    });
   }else node.textContent=visible;
   if(follow)scroller.scrollTop=scroller.scrollHeight;
   if(shown<text.length)schedule();else settle();
  }
  return {update(event){
   if(disposed)return;
   if(event.type==='answer_complete'){
    if(!node||shown>=text.length)return;
    deadline=Date.now()+600;schedule();return new Promise(resolve=>{finishResolve=resolve;});
   }
   if(event.type==='answer_reset'){if(!event.id||id===event.id)clear();return;}
   if(event.type==='answer_start'){
    clear();id=event.id;live=event.verified===false||event.animate===true;node=document.createElement('div');node.className='chat-answer-preview';node.style.cssText=`white-space:${typeof renderMarkdown==='function'?'normal':'pre-wrap'};overflow-wrap:anywhere;font:inherit;line-height:1.8;color:inherit;`;
    node.setAttribute('aria-label','Câu trả lời đang được tạo');host.append(node);host.classList.add('has-answer-preview');return;
   }
   if(event.type!=='answer_delta'||event.id!==id||!Number.isInteger(event.seq)||event.seq!==seq+1||typeof event.delta!=='string')return;
   if(text.length+event.delta.length>256000)return;
   seq=event.seq;text+=event.delta;
   schedule();
  },dispose(){disposed=true;clear();}};
 }
 global.ChatStream={read,createPreview,followResponse,beginWorkflowSubmission,holdWorkflowUpdate};
})(window);
