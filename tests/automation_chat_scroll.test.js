'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
test('workflow forms reach the chat bottom after mounting and resizing without pulling a reader down', {skip:process.env.KNOWLEDGEHUB_TEST_BROWSER!=='1'}, async t=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||path.join(os.tmpdir(),'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser=await chromium.launch({executablePath:process.env.TEST_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('http://localhost:12345/**',route=>route.fulfill({contentType:'text/html',body:'<main></main>'}));
  await page.goto('http://localhost:12345/');
  await page.setContent('<main id="page-chat-messages-container"><div style="height:400px">Older messages</div></main>');
  await page.addStyleTag({content:fs.readFileSync('src/frontend/css/workflow_plugins.css','utf8')+'\n#page-chat-messages-container{height:220px;overflow:auto}'});
  await page.addScriptTag({content:fs.readFileSync('src/frontend/js/modules/workflow_plugins.js','utf8')});
  await page.evaluate(()=>{
    const container=document.querySelector('main');
    const execution={id:'scroll-run',name:'Report',status:'WAITING_INPUT',revision:1,missingInputs:Array.from({length:8},(_,i)=>({key:`field-${i}`,ask:`Field ${i}`,schema:{type:'string'}}))};
    container.insertAdjacentHTML('beforeend',window.renderWorkflowExecution(execution));
    container.scrollTop=container.scrollHeight;
  });
  const bottom=()=>page.waitForFunction(()=>{const e=document.querySelector('main');return e.querySelector('form')&&e.scrollHeight-e.scrollTop-e.clientHeight<2;});
  await bottom();
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='160px';document.querySelector('[data-automation-run]').appendChild(spacer);});
  await bottom();
  await page.evaluate(()=>document.querySelector('main').scrollTop=0);
  await page.waitForFunction(()=>document.querySelector('main').scrollTop===0);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='160px';document.querySelector('[data-automation-run]').appendChild(spacer);});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('main').evaluate(e=>e.scrollTop),0);
});

test('embed scroll settles after a tall workflow form is rendered', {skip:process.env.KNOWLEDGEHUB_TEST_BROWSER!=='1'}, async t=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||path.join(os.tmpdir(),'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser=await chromium.launch({executablePath:process.env.TEST_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.route('http://localhost:12345/**',route=>{
    const url=route.request().url();
    if(url.endsWith('/embed.js'))return route.fulfill({contentType:'text/javascript; charset=utf-8',body:fs.readFileSync('src/frontend/embed/knowledgehub-chat.js','utf8')});
    if(url.endsWith('/api/embed/chat'))return route.fulfill({json:{status:'success',execution:{id:'embed-scroll',name:'Report',status:'WAITING_INPUT',revision:1,missingInputs:Array.from({length:8},(_,i)=>({key:`field-${i}`,ask:`Field ${i}`,schema:{type:'string'}}))}}});
    return route.fulfill({contentType:'text/html; charset=utf-8',body:'<html><body><script src="/embed.js" data-embed-id="fixture"></script></body></html>'});
  });
  await page.goto('http://localhost:12345/');
  const host=page.locator('#knowledgehub-embed-host');
  await host.getByRole('button',{name:'M\u1edf tr\u1ee3 l\u00fd AI',exact:true}).click();
  await page.evaluate(()=>document.querySelector('#knowledgehub-embed-host').shadowRoot.querySelector('.kh-embed-panel').style.height='350px');
  await host.getByLabel('C\u00e2u h\u1ecfi',{exact:true}).fill('Report');
  await host.getByRole('button',{name:'G\u1eedi',exact:true}).click();
  await page.waitForFunction(()=>{const root=document.querySelector('#knowledgehub-embed-host').shadowRoot,e=root.querySelector('.kh-embed-messages');return root.querySelectorAll('.kh-workflow input').length===8&&e.scrollHeight-e.scrollTop-e.clientHeight<2;});
  assert.equal(await host.locator('.kh-workflow input').count(),8);
});
