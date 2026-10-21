'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../../..','uploads','chat');
const MAX_FILE=10*1024*1024, MAX_TOTAL=20*1024*1024, MAX_FILES=5;
const EXTENSIONS=new Set(['.pdf','.doc','.docx','.txt','.md','.rtf','.odt','.csv','.xls','.xlsx','.ppt','.pptx','.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff','.heic','.avif']);
const REPLY='Tính năng xử lý tệp đang phát triển.';
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
 const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.avif':'image/avif','.pdf':'application/pdf','.txt':'text/plain','.md':'text/plain','.csv':'text/plain'};
 return {name:file.name,size:bytes.length,type:types[path.extname(file.storedName)]||'application/octet-stream',bytes};
}
function validate(files) {
 if(!Array.isArray(files)||!files.length||files.length>MAX_FILES)throw fail('Mỗi lần gửi từ 1 đến 5 tệp.');
 let total=0;
 return files.map(file=>{
  if(typeof file?.name!=='string'||!file.name||file.name.length>255)throw fail('Tên tệp không hợp lệ.');
  const extension=path.extname(file.name).toLowerCase();
  if(!EXTENSIONS.has(extension))throw fail('Chỉ hỗ trợ tài liệu và ảnh.');
  if(typeof file.base64!=='string'||file.base64.length>Math.ceil(MAX_FILE/3)*4)throw fail('Mỗi tệp tối đa 10 MB.',413);
  const bytes=Buffer.from(file.base64,'base64');
  if(bytes.toString('base64')!==file.base64)throw fail('Dữ liệu tệp không hợp lệ.');
  if(!bytes.length||bytes.length>MAX_FILE)throw fail('Tệp phải có nội dung và không vượt quá 10 MB.',413);
  if(file.size!==bytes.length)throw fail('Kích thước tệp không khớp.');
  total+=bytes.length;
  if(total>MAX_TOTAL)throw fail('Tổng dung lượng mỗi lần gửi tối đa 20 MB.',413);
  return {name:file.name,extension,bytes,type:typeof file.type==='string'?file.type.slice(0,150):''};
 });
}
function response(manifest) {
 return {status:'success',completionStatus:'SUCCESS',reply:REPLY,replyText:REPLY,batchId:manifest.id,
  attachments:manifest.files.map(({id,name,size,type})=>({id,name,size,type})),fileProcessingStatus:'in_development'};
}
async function submit(owner,body,{root=ROOT}={}) {
 if(!owner)throw fail('Bạn cần đăng nhập để tải tệp.',401);
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail('Yêu cầu tải tệp không hợp lệ.');
 if(body.batchId) {
  if(typeof body.batchId!=='string'||body.batchId.length!==36||!Array.from(body.batchId).every(c=>'0123456789abcdef-'.includes(c)))throw fail('Không tìm thấy tệp.',404);
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(root,body.batchId,'manifest.json'),'utf8'));}catch{throw fail('Không tìm thấy tệp.',404);}
  if(manifest.owner!==owner)throw fail('Không tìm thấy tệp.',404);
  return response(manifest);
 }
 const files=validate(body.files),id=crypto.randomUUID(),directory=path.join(root,id);
 const manifest={id,owner,sessionId:String(body.sessionId||'').slice(0,200),question:String(body.question||'').slice(0,4000),channel:body.channel||'chat',createdAt:new Date().toISOString(),processingStatus:'in_development',files:[]};
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const written=[];
 try {
  for(const file of files) {
   const fileId=crypto.randomUUID(),storedName=fileId+file.extension,target=path.join(directory,storedName);
   await fs.writeFile(target,file.bytes,{flag:'wx',mode:0o600});written.push(target);
   manifest.files.push({id:fileId,name:file.name,type:file.type,size:file.bytes.length,storedName,sha256:crypto.createHash('sha256').update(file.bytes).digest('hex')});
  }
  const manifestPath=path.join(directory,'manifest.json');
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});written.push(manifestPath);
  await fs.appendFile(path.join(root,'uploads.jsonl'),JSON.stringify(manifest)+'\n',{mode:0o600});
 }catch(error){await Promise.allSettled(written.map(target=>fs.unlink(target)));await fs.rmdir(directory).catch(()=>{});throw error;}
 return response(manifest);
}
module.exports={submit,read,validate,ROOT,MAX_FILE,MAX_TOTAL,MAX_FILES};
