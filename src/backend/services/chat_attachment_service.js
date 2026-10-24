'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const processing=require('./attachment_processing');
const ROOT=path.resolve(__dirname,'../../..','uploads','chat');
const MAX_FILE=10*1024*1024, MAX_TOTAL=20*1024*1024, MAX_FILES=5;
const EXTENSIONS=new Set(['.pdf','.docx','.txt','.md','.csv','.xlsx','.png','.jpg','.jpeg','.webp']);
const REPLY='Tính năng xử lý tệp đang phát triển.';
const retentionDays=()=>Math.max(1,Number(process.env.CHAT_ATTACHMENT_RETENTION_DAYS)||7);
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const validId=value=>typeof value==='string'&&value.length===36&&Array.from(value).every(c=>'0123456789abcdef-'.includes(c));
async function read(owner,batchId,fileId,{root=ROOT}={}) {
 if(!owner)throw fail('Bạn cần đăng nhập.',401);
 if(!validId(batchId)||!validId(fileId))throw fail('Không tìm thấy tệp.',404);
 let manifest;
 try{manifest=JSON.parse(await fs.readFile(path.join(root,batchId,'manifest.json'),'utf8'));}catch{throw fail('Không tìm thấy tệp.',404);}
 if(manifest.owner!==owner)throw fail('Không tìm thấy tệp.',404);
 const file=manifest.files.find(item=>item.id===fileId);
 if(!file||path.basename(file.storedName)!==file.storedName)throw fail('Không tìm thấy tệp.',404);
 const bytes=await fs.readFile(path.join(root,batchId,file.storedName));
 const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.txt':'text/plain','.md':'text/plain','.csv':'text/plain'};
 return {name:file.name,size:bytes.length,type:types[path.extname(file.storedName)]||'application/octet-stream',bytes};
}
function validate(files) {
 if(!Array.isArray(files)||!files.length||files.length>MAX_FILES)throw fail('Mỗi lần gửi từ 1 đến 5 tệp.');
 let total=0;
 return files.map(file=>{
  if(typeof file?.name!=='string'||!file.name||file.name.length>255)throw fail('Tên tệp không hợp lệ.');
  const extension=path.extname(file.name).toLowerCase();
  if(!EXTENSIONS.has(extension))throw fail('Chỉ hỗ trợ PDF, DOCX, XLSX, CSV, TXT, MD và ảnh PNG, JPG, WEBP.');
  if(typeof file.base64!=='string'||file.base64.length>Math.ceil(MAX_FILE/3)*4)throw fail('Mỗi tệp tối đa 10 MB.',413);
  const bytes=Buffer.from(file.base64,'base64');
  if(bytes.toString('base64')!==file.base64)throw fail('Dữ liệu tệp không hợp lệ.');
  if(!bytes.length||bytes.length>MAX_FILE)throw fail('Tệp phải có nội dung và không vượt quá 10 MB.',413);
  if(file.size!==bytes.length)throw fail('Kích thước tệp không khớp.');
  total+=bytes.length;
  if(total>MAX_TOTAL)throw fail('Tổng dung lượng mỗi lần gửi tối đa 20 MB.',413);
  const {mimeType}=processing.inspect(file.name,extension,bytes);
  return {name:file.name,extension,bytes,mimeType,type:typeof file.type==='string'?file.type.slice(0,150):''};
 });
}
// Each entry is a stored file plus the batch folder that holds it; the folder never leaves the server.
const entriesOf=(manifest,directory)=>manifest.files.map(file=>({...file,batchId:manifest.id,directory}));
function response(entries,batchId,result) {
 const reply=result?.reply||REPLY,status=result?'processed':'in_development';
 return {status:'success',completionStatus:'SUCCESS',reply,replyText:reply,batchId,
  tokenUsage:result?.tokenUsage||null,providerId:result?.providerId||null,modelName:result?.modelName||null,providerName:result?.providerName||null,
  provider:result?.providerId?{id:result.providerId,name:result.providerName,model:result.modelName}:null,
  attachments:entries.map(({id,name,size,type,batchId:owner,processing:state})=>({id,name,size,type,batchId:owner,...(state?{processingStatus:state.status,processingNote:state.note||null}:{})})),fileProcessingStatus:status};
}
// The audit log carries file metadata only; questions and content stay inside the batch folder.
const auditEntry=({question,...manifest})=>manifest;
const lastCleanup=new Map();
async function cleanup(root=ROOT,{now=Date.now(),force=false}={}) {
 if(!force&&now-(lastCleanup.get(root)||0)<60*60*1000)return 0;
 lastCleanup.set(root,now);
 const cutoff=now-retentionDays()*24*60*60*1000;
 let removed=0;
 for(const name of await fs.readdir(root).catch(()=>[])) {
  if(!validId(name))continue;
  let created;
  try{created=Date.parse(JSON.parse(await fs.readFile(path.join(root,name,'manifest.json'),'utf8')).createdAt);}catch{continue;}
  if(created<cutoff){await fs.rm(path.join(root,name),{recursive:true,force:true});removed++;}
 }
 const log=path.join(root,'uploads.jsonl');
 const lines=(await fs.readFile(log,'utf8').catch(()=>'')).split('\n').filter(Boolean);
 const kept=lines.filter(line=>{try{return Date.parse(JSON.parse(line).createdAt)>=cutoff;}catch{return false;}});
 if(kept.length!==lines.length)await fs.writeFile(log,kept.map(line=>JSON.stringify(auditEntry(JSON.parse(line)))+'\n').join(''),{mode:0o600});
 return removed;
}
async function loadBatch(root,owner,batchId) {
 if(!validId(batchId))throw fail('Không tìm thấy tệp.',404);
 let manifest;
 try{manifest=JSON.parse(await fs.readFile(path.join(root,batchId,'manifest.json'),'utf8'));}catch{throw fail('Không tìm thấy tệp.',404);}
 if(manifest.owner!==owner)throw fail('Không tìm thấy tệp.',404);
 return {manifest,directory:path.join(root,batchId)};
}
// Files uploaded earlier can be asked about again without uploading them a second time.
async function resolveRefs(root,owner,refs) {
 if(!Array.isArray(refs)||refs.length>MAX_FILES)throw fail('Mỗi lần hỏi tối đa 5 tệp.');
 const batches=new Map(),entries=[];
 for(const ref of refs) {
  if(!validId(ref?.batchId)||!validId(ref?.fileId))throw fail('Không tìm thấy tệp.',404);
  if(!batches.has(ref.batchId))batches.set(ref.batchId,await loadBatch(root,owner,ref.batchId));
  const {manifest,directory}=batches.get(ref.batchId),file=manifest.files.find(item=>item.id===ref.fileId);
  if(!file||path.basename(file.storedName)!==file.storedName)throw fail('Không tìm thấy tệp.',404);
  if(!entries.some(entry=>entry.id===file.id))entries.push({...file,batchId:manifest.id,directory});
 }
 return entries;
}
async function ownerBatches(root,owner) {
 const batches=[];
 for(const name of await fs.readdir(root).catch(()=>[])) {
  if(!validId(name))continue;
  try {
   const manifest=JSON.parse(await fs.readFile(path.join(root,name,'manifest.json'),'utf8'));
   if(manifest.owner===owner)batches.push({manifest,directory:path.join(root,name)});
  }catch{}
 }
 return batches;
}
// A file uploaded again with identical bytes takes over the earlier reading instead of being read again.
// Only the same owner's uploads are searched, so one account's extract never serves another.
async function reuseExtracts(root,owner,entries) {
 const extractPath=(directory,fileId)=>path.join(directory,`${fileId}.extract.json`);
 const missing=[];
 for(const entry of entries) { try{await fs.access(extractPath(entry.directory,entry.id));}catch{if(entry.sha256)missing.push(entry);} }
 if(!missing.length)return 0;
 const batches=await ownerBatches(root,owner);
 let reused=0;
 for(const entry of missing) {
  for(const {manifest,directory} of batches) {
   const donor=manifest.files.find(file=>file.sha256===entry.sha256&&file.id!==entry.id);
   if(!donor)continue;
   let extract;
   try{extract=JSON.parse(await fs.readFile(extractPath(directory,donor.id),'utf8'));}catch{continue;}
   if(extract.extractorVersion!==processing.EXTRACTOR_VERSION||extract.sha256!==entry.sha256||!['ready','partial'].includes(extract.status))continue;
   await fs.writeFile(extractPath(entry.directory,entry.id),JSON.stringify({...extract,fileId:entry.id,name:entry.name,reusedFrom:donor.id}),{mode:0o600});
   reused++;break;
  }
 }
 return reused;
}
async function list(owner,sessionId,{root=ROOT}={}) {
 if(!owner)throw fail('Bạn cần đăng nhập.',401);
 if(typeof sessionId!=='string'||!sessionId||sessionId.length>200)throw fail('Thiếu mã cuộc trò chuyện.');
 const files=[];
 for(const {manifest} of await ownerBatches(root,owner)) {
  if(manifest.sessionId!==sessionId)continue;
  for(const file of manifest.files.filter(file=>!file.hiddenFromList))files.push({id:file.id,batchId:manifest.id,name:file.name,size:file.size,type:file.type,createdAt:manifest.createdAt,processingStatus:file.processing?.status||null,sha256:file.sha256});
 }
 // The same content uploaded several times is listed once: the latest upload, with how often it was sent.
 const unique=new Map();
 for(const file of files.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||a.name.localeCompare(b.name))) {
  const key=file.sha256||`${file.batchId}:${file.id}`,seen=unique.get(key);
  if(seen){seen.uploads++;continue;}
  unique.set(key,{...file,uploads:1});
 }
 return [...unique.values()].map(({sha256,...file})=>file);
}
async function answerFiles(entries,batch,body,options) {
 const batchId=batch?.manifest.id||null;
 if(!processing.enabled())return response(entries,batchId);
 const run=options.processor||processing.answer;
 let result;
 try{result=await run({files:entries,question:typeof body.question==='string'?body.question.slice(0,4000):batch?.manifest.question||'',
  providerId:typeof body.providerId==='string'?body.providerId.slice(0,100):null,history:body.history,signal:options.signal});}
 catch(error) {
  // The files are already stored, so report a processing failure the user can retry with the same files.
  if(options.signal?.aborted)throw error;
  console.error('[Attachments] Processing failed:',error.code||error.name,String(error.message||'').slice(0,200));
  const reply='Đã lưu tệp nhưng AI chưa xử lý được (mô hình không phản hồi hoặc quá thời gian). Hãy thử lại.';
  return {...response(entries,batchId),reply,replyText:reply,completionStatus:'ERROR',fileProcessingStatus:'failed'};
 }
 const states=new Map((result.files||[]).map(item=>[item.fileId,{status:item.status,reader:item.reader,note:item.note}]));
 if(batch) {
  batch.manifest.files=batch.manifest.files.map(file=>states.has(file.id)?{...file,processing:states.get(file.id)}:file);
  Object.assign(batch.manifest,{processingStatus:'processed',processedAt:new Date().toISOString(),answeredBy:result.providerId||null});
  await fs.writeFile(path.join(batch.directory,'manifest.json'),JSON.stringify(batch.manifest,null,2),{mode:0o600});
 }
 return response(entries.map(entry=>states.has(entry.id)?{...entry,processing:states.get(entry.id)}:entry),batchId,result);
}
async function submit(owner,body,{root=ROOT,...options}={}) {
 if(!owner)throw fail('Bạn cần đăng nhập để tải tệp.',401);
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Yêu cầu tải tệp không hợp lệ.');
 cleanup(root).catch(()=>{});
 const refs=body.fileRefs===undefined?[]:await resolveRefs(root,owner,body.fileRefs);
 const combine=batchEntries=>[...batchEntries,...refs.filter(ref=>!batchEntries.some(entry=>entry.id===ref.id))];
 if(body.batchId) {
  const batch=await loadBatch(root,owner,body.batchId);
  return answerFiles(combine(entriesOf(batch.manifest,batch.directory)),batch,body,options);
 }
 if(body.files===undefined&&refs.length)return answerFiles(refs,null,body,options);
 const files=validate(body.files),id=crypto.randomUUID(),directory=path.join(root,id);
 if(files.length+refs.length>MAX_FILES)throw fail('Mỗi lần hỏi tối đa 5 tệp.');
 const manifest={id,owner,sessionId:String(body.sessionId||'').slice(0,200),question:String(body.question||'').slice(0,4000),channel:body.channel||'chat',createdAt:new Date().toISOString(),processingStatus:'pending',files:[]};
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const written=[];
 try {
  for(const file of files) {
   const fileId=crypto.randomUUID(),storedName=fileId+file.extension,target=path.join(directory,storedName);
   await fs.writeFile(target,file.bytes,{flag:'wx',mode:0o600});written.push(target);
   manifest.files.push({id:fileId,name:file.name,type:file.type,mimeType:file.mimeType,size:file.bytes.length,storedName,sha256:crypto.createHash('sha256').update(file.bytes).digest('hex')});
  }
  const manifestPath=path.join(directory,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});written.push(manifestPath);
  await fs.appendFile(path.join(root,'uploads.jsonl'),JSON.stringify(auditEntry(manifest))+'\n',{mode:0o600});
 }catch(error){await Promise.allSettled(written.map(target=>fs.unlink(target)));await fs.rmdir(directory).catch(()=>{});throw error;}
 if(processing.enabled())await reuseExtracts(root,owner,entriesOf(manifest,directory)).catch(()=>0);
 return answerFiles(combine(entriesOf(manifest,directory)),{manifest,directory},body,options);
}
async function hideFromList(owner,{sessionId,batchId,fileId},{root=ROOT}={}) {
 if(!owner)throw fail('Bạn cần đăng nhập.',401);
 const selected=await loadBatch(root,owner,batchId);
 const target=selected.manifest.files.find(file=>file.id===fileId);
 if(!target||selected.manifest.sessionId!==sessionId)throw fail('Không tìm thấy tệp.',404);
 for(const batch of await ownerBatches(root,owner)) {
  if(batch.manifest.sessionId!==sessionId)continue;
  let changed=false;
  for(const file of batch.manifest.files)if(file.id===fileId||(target.sha256&&file.sha256===target.sha256)){file.hiddenFromList=true;changed=true;}
  if(changed)await fs.writeFile(path.join(batch.directory,'manifest.json'),JSON.stringify(batch.manifest,null,2),{mode:0o600});
 }
 return {status:'success'};
}
module.exports={submit,read,list,hideFromList,validate,cleanup,ROOT,MAX_FILE,MAX_TOTAL,MAX_FILES};
