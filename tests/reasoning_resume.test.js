const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  const events={},frames=[],root={_reasoningStopped:false},inner={hidden:false,scrollTop:0,scrollHeight:900,closest:()=>root};
  const container={clientHeight:300,scrollHeight:1000,scrollTop:700,querySelectorAll:()=>[inner]};
  const follower={following:true,sync(){if(this.following)container.scrollTop=container.scrollHeight-container.clientHeight},resume(){this.following=true;this.sync()}};
  const document={hidden:false,addEventListener:(name,fn)=>events[name]=fn,querySelectorAll:()=>[container]};
  const window={addEventListener:(name,fn)=>events[name]=fn,ChatStream:{followResponse:()=>follower}};
  vm.runInNewContext(fs.readFileSync('src/frontend/shared/js/chat_reasoning_ui.js','utf8'),{window,document,requestAnimationFrame:fn=>frames.push(fn)});
  return {window,document,container,inner,follower,root,events,flush(){while(frames.length)frames.shift()()}};
}
test('returning to a streaming response resumes both outer chat and reasoning at the latest text',()=>{
  const f=fixture();f.container.scrollHeight=1500;
  f.document.hidden=true;f.events.visibilitychange();f.flush();assert.equal(f.inner.scrollTop,0);
  f.document.hidden=false;f.events.visibilitychange();f.flush();
  assert.equal(f.container.scrollTop,1200);assert.equal(f.inner.scrollTop,900);
  f.inner.scrollTop=0;f.window.ChatReasoningUI.resumeAtEnd(f.container);f.flush();assert.equal(f.inner.scrollTop,900);
});
test('returning does not move a reader above the active response, hidden panels or collapsed reasoning',()=>{
  const f=fixture();f.follower.following=false;f.container.scrollTop=20;
  f.events.focus();f.flush();assert.equal(f.inner.scrollTop,0);assert.equal(f.container.scrollTop,20);
  f.container.clientHeight=0;f.window.ChatReasoningUI.resumeAtEnd(f.container);f.flush();assert.equal(f.inner.scrollTop,0);
  f.container.clientHeight=300;f.container.scrollTop=700;f.inner.hidden=true;
  f.events.focus();f.flush();assert.equal(f.inner.scrollTop,0);
  f.inner.hidden=false;f.events.focus();f.flush();assert.equal(f.inner.scrollTop,900);
});
