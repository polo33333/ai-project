'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const service=require('../src/backend/services/chat_attachment_service');
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000020000000208060000','hex'),Buffer.alloc(8)]);
const file=(name='báo cáo.pdf',text='%PDF-1.4 Document bytes')=>({name,type:'application/pdf',size:Buffer.byteLength(text),base64:Buffer.from(text).toString('base64')});

test('chat uploads store exact bytes and an owner-scoped audit, returning only the development response when processing is off',async t=>{
 process.env.CHAT_ATTACHMENT_PROCESSING_ENABLED='false';t.after(()=>{delete process.env.CHAT_ATTACHMENT_PROCESSING_ENABLED;});
 const prefix=path.join(os.tmpdir(),'kh-chat-upload-');
 const root=await fs.mkdtemp(prefix);
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));await fs.rm(root,{recursive:true,force:true});});
 assert.equal(service.ROOT,path.resolve(__dirname,'../uploads/chat'));
 const result=await service.submit('account-A',{files:[file(),{name:'../../image.png',type:'image/png',size:PNG.length,base64:PNG.toString('base64')}],sessionId:'session-A',question:'Read these'},{root});
 assert.equal(result.reply,'Tính năng xử lý tệp đang phát triển.');
 assert.equal(result.completionStatus,'SUCCESS');assert.equal(result.attachments.length,2);
 assert.equal(result.files,undefined);assert.equal(result.owner,undefined);
 const manifest=JSON.parse(await fs.readFile(path.join(root,result.batchId,'manifest.json'),'utf8'));
 assert.equal(manifest.owner,'account-A');assert.equal(manifest.sessionId,'session-A');
 assert.equal(manifest.processingStatus,'pending');assert.ok(manifest.createdAt);assert.equal(manifest.files[1].mimeType,'image/png');
 for(const stored of manifest.files){assert.equal(path.basename(stored.storedName),stored.storedName);assert.equal(stored.sha256.length,64);}
 assert.equal(await fs.readFile(path.join(root,result.batchId,manifest.files[0].storedName),'utf8'),'%PDF-1.4 Document bytes');
 const log=JSON.parse((await fs.readFile(path.join(root,'uploads.jsonl'),'utf8')).trim());
 const {question,...audited}=manifest;assert.equal(question,'Read these');assert.deepEqual(log,audited);
 const downloaded=await service.read('account-A',result.batchId,result.attachments[0].id,{root});
 assert.equal(downloaded.bytes.toString(),'%PDF-1.4 Document bytes');assert.equal(downloaded.type,'application/pdf');
 await assert.rejects(service.read('account-B',result.batchId,result.attachments[0].id,{root}),{statusCode:404});
 await assert.rejects(service.read('account-A','../../outside',result.attachments[0].id,{root}),{statusCode:404});
 await assert.rejects(service.read('account-A',result.batchId,'../../outside',{root}),{statusCode:404});
 await assert.rejects(service.submit('account-B',{batchId:result.batchId},{root}),{statusCode:404});
 await assert.rejects(service.submit('account-A',{batchId:'../../outside'},{root}),{statusCode:404});
 const retry=await service.submit('account-A',{batchId:result.batchId},{root});
 assert.equal(retry.reply,result.reply);assert.equal((await fs.readdir(root)).length,2);
});

test('upload validation rejects unsupported, corrupt, empty, oversized and excessive files before writing',async()=>{
 assert.throws(()=>service.validate([file('run.exe')]),{statusCode:400});
 assert.throws(()=>service.validate([file('x.svg')]),{statusCode:400});
 assert.throws(()=>service.validate([file('x.gif')]),{statusCode:400});
 assert.throws(()=>service.validate([file('fake.pdf','not a pdf')]),{statusCode:400});
 assert.throws(()=>service.validate([file('fake.png','%PDF-1.4')]),{statusCode:400});
 assert.throws(()=>service.validate([{...file(),base64:'not base64'}]),{statusCode:400});
 assert.throws(()=>service.validate([{...file(),size:999}]),{statusCode:400});
 assert.throws(()=>service.validate([file('empty.pdf','')]),{statusCode:413});
 assert.throws(()=>service.validate(Array.from({length:6},()=>file())),{statusCode:400});
 const large=file('big.pdf','%PDF-'+'x'.repeat(service.MAX_FILE));
 assert.throws(()=>service.validate([large]),{statusCode:413});
 const medium=file('medium.pdf','%PDF-'+'x'.repeat(8*1024*1024));
 assert.throws(()=>service.validate([medium,medium,medium]),{statusCode:413});
 await assert.rejects(service.submit(null,{files:[file()]}),{statusCode:401});
});

test('shared picker enforces limits and sends bytes to upload endpoint without invoking chat',async()=>{
 const source=await fs.readFile(path.join(__dirname,'../src/frontend/embed-client/chat-attachments.js'),'utf8');
 const requests=[],global={window:{},FileReader:class{readAsDataURL(file){this.result='data:application/pdf;base64,'+Buffer.from(file.text).toString('base64');this.onload();}},fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({reply:'development'})};}};
 vm.runInNewContext(source,global);
 const helper=global.window.ChatAttachments,notices=[];
 const picked=helper.add([],[{name:'a.pdf',size:3,text:'abc'},{name:'x.exe',size:3}],message=>notices.push(message));
 assert.equal(picked.length,1);assert.equal(notices.length,1);assert.ok(helper.accept.includes('.png'));
 await helper.submit(picked,{sessionId:'session'});
 assert.equal(requests[0].url,'/api/chat/attachments');assert.equal(requests[0].body.files[0].base64,'YWJj');
 assert.equal(requests[0].body.sessionId,'session');
});
