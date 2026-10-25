'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 const input={disabled:false,value:'Keep this'},submit={disabled:false,textContent:'Continue'};
 const form={children:[],querySelectorAll:()=>[input,submit],appendChild(node){this.children.push(node);}};
 const badge={textContent:'Waiting'},node={dataset:{},attributes:{},setAttribute(key,value){this.attributes[key]=value;},querySelector:()=>badge};
 const context=vm.createContext({window:{},document:{createElement(){return {style:{},setAttribute(){},remove(){form.children=form.children.filter(item=>item!==this);}};}}});
 vm.runInContext(fs.readFileSync('src/frontend/embed-client/chat-stream.js','utf8'),context);
 return {ui:context.window.ChatStream,input,submit,form,badge,node};
}
test('workflow submission retains form and values through stale polls and running steps, then releases at completion',()=>{
 const {ui,input,submit,form,badge,node}=fixture();
 const execution={id:'run',revision:1,status:'WAITING_INPUT'};
 const pending=ui.beginWorkflowSubmission(node,form,submit,execution);
 assert.equal(input.disabled,true);assert.equal(submit.disabled,true);assert.equal(input.value,'Keep this');
 assert.equal(ui.beginWorkflowSubmission(node,form,submit,execution),null,'do not create a duplicate submission');
 assert.equal(ui.holdWorkflowUpdate(node,execution),true,'a stale waiting poll must not replace the pending form');
 pending.received();
 assert.equal(ui.holdWorkflowUpdate(node,{id:'run',revision:2,status:'READY'}),true);
 assert.equal(ui.holdWorkflowUpdate(node,{id:'run',revision:3,status:'RUNNING',steps:[{name:'Current step',status:'RUNNING'}]}),true);
 assert.ok(form.children[0].textContent.includes('Current step'));assert.equal(badge.textContent,'Đang xử lý');
 assert.equal(ui.holdWorkflowUpdate(node,{id:'run',revision:1,status:'WAITING_INPUT'}),true);
 assert.equal(ui.holdWorkflowUpdate(node,{id:'run',revision:4,status:'SUCCEEDED'}),false);
 assert.equal(input.disabled,false);assert.equal(submit.disabled,false);assert.equal(form.children.length,0);
});
test('workflow network failure and additional inputs restore controls without losing entered values',()=>{
 for(const outcome of ['failure','WAITING_INPUT']){
  const {ui,input,submit,form,node}=fixture();
  const pending=ui.beginWorkflowSubmission(node,form,submit,{id:'run',revision:1});
  pending.received();
  if(outcome==='failure')pending.release();
  else assert.equal(ui.holdWorkflowUpdate(node,{id:'run',revision:2,status:outcome}),false);
  assert.equal(input.value,'Keep this');assert.equal(input.disabled,false);assert.equal(submit.disabled,false);
  assert.equal(form.children.length,0);assert.equal(node.attributes['aria-busy'],'false');
 }
});
