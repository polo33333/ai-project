(function(global){
 'use strict';
 const extensions=['pdf','doc','docx','txt','md','rtf','odt','csv','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp','gif','bmp','tif','tiff','heic','avif'];
 const accept=extensions.map(value=>'.'+value).join(',');
 function add(current,incoming,notify){
  const result=[...current];
  for(const file of incoming){
   const extension=file.name.split('.').pop().toLowerCase();
   let error='';
   if(!extensions.includes(extension))error='Chỉ hỗ trợ tài liệu và ảnh.';
   else if(!file.size||file.size>10*1024*1024)error='Mỗi tệp phải có nội dung và không vượt quá 10 MB.';
   else if(result.some(item=>item.name===file.name&&item.size===file.size))continue;
   else if(result.length>=5)error='Mỗi lần gửi tối đa 5 tệp.';
   else if(result.reduce((sum,item)=>sum+item.size,0)+file.size>20*1024*1024)error='Tổng dung lượng tối đa 20 MB.';
   if(error)notify?.(error);else result.push(file);
  }
  return result;
 }
 function encode(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,type:file.type,size:file.size,base64:String(reader.result).split(',')[1]});reader.onerror=()=>reject(new Error('Không đọc được tệp '+file.name));reader.readAsDataURL(file);});}
 async function submit(files,metadata={},signal,endpoint='/api/chat/attachments'){
  const payload={...metadata,...(files.length?{files:await Promise.all(files.map(encode))}:{})};
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify(payload)});
  const data=await response.json();
  if(!response.ok)throw new Error(data.message||'Không tải được tệp. Hãy thử lại.');
  return data;
 }
 const localFiles=new Map(),localKeys=new WeakMap();
 const extension=file=>String(file.name||'').split('.').pop().toLowerCase();
 const imageExtensions=new Set(['png','jpg','jpeg','gif','webp','bmp','tif','tiff','heic','avif']);
 const textExtensions=new Set(['txt','md','csv']);
 const sizeLabel=size=>size>=1048576?(size/1048576).toFixed(1)+' MB':Math.max(1,Math.ceil(size/1024))+' KB';
 function describe(files,batchId){return files.map(file=>{
  if(typeof file.arrayBuffer==='function'){
   let key=localKeys.get(file);if(!key){key=global.crypto.randomUUID();localKeys.set(file,key);localFiles.set(key,file);}
   return {name:file.name,size:file.size,type:file.type,localKey:key};
  }
  return {...file,...(batchId?{batchId}:{})};
 });}
 function release(files){files.forEach(file=>{const key=localKeys.get(file)||file.localKey;if(key)localFiles.delete(key);localKeys.delete(file);});}
 const css=`
 .chat-file-cards{display:flex;flex-wrap:wrap;gap:10px;min-width:0;max-width:100%;padding:2px 0}
 .chat-file-card{position:relative;flex:0 0 148px;max-width:100%;color:#263247;background:#fff;border:1px solid #dce2ed;border-radius:13px;overflow:hidden;text-align:left;box-sizing:border-box}
 .chat-file-open{display:flex;flex-direction:column;gap:8px;width:100%;min-height:132px;padding:12px;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;box-sizing:border-box}
 .chat-file-open:hover{background:rgba(113,88,235,.06)}.chat-file-open:focus-visible,.chat-file-remove:focus-visible{outline:2px solid #7962ef;outline-offset:-3px}
 .chat-file-name{font-size:12px;font-weight:600;line-height:1.45;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;padding-right:14px;min-width:0}
 .chat-file-meta{display:block;font-size:11px;line-height:1.4;color:#7b8496;margin-top:auto}.chat-file-kind{align-self:flex-start;padding:2px 5px;border-radius:5px;font-size:10px;font-weight:700;background:#efedf8;color:#7560c9}
 .chat-file-image{width:100%;height:76px;object-fit:cover;border-radius:7px;background:#f0f2f8}.chat-file-card:has(.chat-file-image) .chat-file-name{-webkit-line-clamp:1;padding-right:0}
 .chat-file-remove{position:absolute;z-index:1;right:5px;top:5px;width:24px;height:24px;border:0;border-radius:50%;display:grid;place-items:center;color:#7c8597;background:rgba(240,242,248,.95);cursor:pointer}.chat-file-remove:hover{color:#dc3545}
 .chat-file-overlay{position:fixed;inset:0;z-index:2147483646;background:rgba(13,18,32,.65);display:grid;place-items:center;padding:20px;box-sizing:border-box;backdrop-filter:blur(4px);color:#25304a;font:14px system-ui,sans-serif}
 .chat-file-dialog{display:flex;flex-direction:column;width:min(100%,1000px);height:min(86dvh,820px);min-width:0;background:#fff;border:1px solid #dce2ed;border-radius:18px;box-shadow:0 24px 80px #0005;overflow:hidden}
 .chat-file-dialog header{display:flex;align-items:center;gap:12px;padding:15px 20px;border-bottom:1px solid #e5e9f2}.chat-file-dialog header strong{flex:1;min-width:0;overflow-wrap:anywhere;font-size:14px}.chat-file-dialog header button,.chat-file-download{border:1px solid #dde2ef;border-radius:8px;background:transparent;color:inherit;padding:8px 12px;font:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}.chat-file-dialog header button{font-size:20px;line-height:1}
 .chat-file-view{flex:1;min-height:0;overflow:auto;display:flex;align-items:center;justify-content:center;padding:20px;background:#f5f6fa}.chat-file-view img{max-width:100%;max-height:100%;object-fit:contain}.chat-file-view iframe{width:100%;height:100%;border:0;background:white}.chat-file-view pre{align-self:flex-start;margin:0;width:100%;font:13px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:inherit}.chat-file-empty{max-width:480px;text-align:center;line-height:1.7}.chat-file-empty strong{display:block;font-size:16px}.chat-file-view:has(pre){align-items:flex-start}
 [data-theme="dark"] .chat-file-card,.dark .chat-file-card{background:#22252d;color:#e7e9ef;border-color:#454955}[data-theme="dark"] .chat-file-meta,.dark .chat-file-meta{color:#a8afbf}[data-theme="dark"] .chat-file-kind,.dark .chat-file-kind{background:#363243;color:#c5b9ef}[data-theme="dark"] .chat-file-remove,.dark .chat-file-remove{background:#353944;color:#d2d7e0}
 .chat-file-overlay.is-dark{color:#e6e9f1}.chat-file-overlay.is-dark .chat-file-dialog{background:#20232b;border-color:#414653}.chat-file-overlay.is-dark header{border-color:#414653}.chat-file-overlay.is-dark .chat-file-view{background:#16191f}.chat-file-overlay.is-dark :is(.chat-file-download,header button){border-color:#4b5060}
 @media(max-width:520px){.chat-file-card{flex-basis:136px}.chat-file-overlay{padding:8px}.chat-file-dialog{height:92dvh;border-radius:13px}.chat-file-dialog header{padding:12px;gap:8px}.chat-file-view{padding:12px}.chat-file-download{font-size:12px;padding:7px 9px}}
 `;
 function installStyles(root=document){if(root.querySelector('style[data-chat-attachments]'))return;const style=document.createElement('style');style.dataset.chatAttachments='true';style.textContent=css;(root.head||root).appendChild(style);}
 async function load(file,loader){
  if(file.localKey){const local=localFiles.get(file.localKey);if(local)return local;throw new Error('Tệp chưa được lưu. Vui lòng chọn lại tệp.');}
  if(loader)return loader(file);
  const response=await fetch('/api/chat/attachments/file?'+new URLSearchParams({batchId:file.batchId,fileId:file.id}));
  if(!response.ok)throw new Error('Không mở được tệp hoặc bạn không có quyền truy cập.');
  return response.blob();
 }
 let closeActive;
 async function preview(file,loader){
  closeActive?.();installStyles();
  const previous=document.activeElement,previousOverflow=document.body.style.overflow,overlay=document.createElement('div');overlay.className='chat-file-overlay';document.body.style.overflow='hidden';
  const theme=document.documentElement.dataset.theme||document.body.dataset.theme;
  if(theme==='dark'||(!theme&&global.matchMedia?.('(prefers-color-scheme: dark)').matches))overlay.classList.add('is-dark');
  const dialog=document.createElement('section');dialog.className='chat-file-dialog';dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label','Xem trước '+file.name);
  const header=document.createElement('header'),name=document.createElement('strong'),download=document.createElement('a'),close=document.createElement('button'),body=document.createElement('div');
  name.textContent=file.name;download.textContent='Tải xuống';download.className='chat-file-download';download.hidden=true;download.download=file.name;close.type='button';close.textContent='×';close.setAttribute('aria-label','Đóng xem trước');body.className='chat-file-view';body.textContent='Đang mở tệp…';
  header.append(name,download,close);dialog.append(header,body);overlay.append(dialog);document.body.appendChild(overlay);close.focus();
  let url,closed=false;
  const key=event=>{if(event.key==='Escape'){event.preventDefault();finish();}else if(event.key==='Tab'){const controls=[download,close].filter(item=>!item.hidden);if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}}};
  function finish(){closed=true;overlay.remove();document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',key,true);if(url)URL.revokeObjectURL(url);if(closeActive===finish)closeActive=null;previous?.focus?.();}
  closeActive=finish;close.onclick=finish;overlay.onclick=event=>{if(event.target===overlay)finish();};document.addEventListener('keydown',key,true);
  try{
   const blob=await load(file,loader);if(closed)return;
   const ext=extension(file);
   url=URL.createObjectURL(ext==='pdf'?new Blob([blob],{type:'application/pdf'}):blob);download.href=url;download.hidden=false;body.replaceChildren();
   if(imageExtensions.has(ext)){
    const img=document.createElement('img');img.alt=file.name;img.src=url;img.onerror=()=>{body.textContent='Trình duyệt chưa hỗ trợ xem định dạng ảnh này. Bạn có thể tải tệp xuống.';};body.append(img);
   }else if(ext==='pdf'){
    const frame=document.createElement('iframe');frame.title='Xem trước '+file.name;frame.src=url;body.append(frame);
   }else if(textExtensions.has(ext)){
    const pre=document.createElement('pre');const text=await blob.slice(0,300000).text();if(closed)return;pre.textContent=text+(blob.size>300000?'\n\n… Chỉ hiển thị phần đầu. Tải xuống để xem toàn bộ.':'');body.append(pre);
   }else{
    const empty=document.createElement('div');empty.className='chat-file-empty';const title=document.createElement('strong');title.textContent=ext.toUpperCase()+' · '+sizeLabel(blob.size);const hint=document.createElement('p');hint.textContent='Chưa hỗ trợ xem trực tiếp định dạng này. Bạn có thể tải xuống để mở bằng ứng dụng tương ứng.';empty.append(title,hint);body.append(empty);
   }
  }catch(error){if(!closed)body.textContent=error.message||'Không xem được tệp.';}
 }
 function render(container,files,{onRemove,loader}={}){
  if(!container)return;installStyles(container.getRootNode());container._chatFileCleanup?.();container.replaceChildren();container.classList.add('chat-file-cards');
  const descriptors=describe(files),urls=[];let disposed=false;
  container._chatFileCleanup=()=>{disposed=true;urls.forEach(url=>URL.revokeObjectURL(url));};
  descriptors.forEach((file,index)=>{
   const card=document.createElement('div');card.className='chat-file-card';const open=document.createElement('button');open.type='button';open.className='chat-file-open';open.title='Xem trước '+file.name;open.setAttribute('aria-label',open.title);open.onclick=()=>preview(file,loader);
   if(imageExtensions.has(extension(file))){
    const img=document.createElement('img');img.className='chat-file-image';img.alt=file.name;open.append(img);
    load(file,loader).then(blob=>{if(disposed)return;const url=URL.createObjectURL(blob);urls.push(url);img.onload=()=>URL.revokeObjectURL(url);img.src=url;}).catch(()=>{img.hidden=true;});
    img.onerror=()=>{img.hidden=true;};
   }
   const name=document.createElement('span');name.className='chat-file-name';name.textContent=file.name;const meta=document.createElement('span');meta.className='chat-file-meta';meta.textContent=sizeLabel(file.size);const kind=document.createElement('span');kind.className='chat-file-kind';kind.textContent=extension(file).toUpperCase();open.append(name,meta,kind);card.append(open);
   if(onRemove){const remove=document.createElement('button');remove.type='button';remove.className='chat-file-remove';remove.title='Xóa '+file.name;remove.setAttribute('aria-label',remove.title);remove.textContent='×';remove.onclick=()=>onRemove(index);card.append(remove);}
   container.append(card);
  });
 }
 global.ChatAttachments={accept,add,submit,describe,render,preview,release};
})(window);
