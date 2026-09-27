'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('SQL editor mouse caret, highlighted selection and deletion agree in business and scope dialogs', {skip:process.env.KNOWLEDGEHUB_TEST_BROWSER!=='1'}, async t=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||path.join(os.tmpdir(),'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser=await chromium.launch({executablePath:process.env.TEST_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:900,height:600}});
  await page.goto('about:blank');
  const source=fs.readFileSync('src/frontend/js/modules/workflow_plugins.js','utf8').replace('  function field(', '  window.testCodeField=codeField;\n  function field(');
  await page.addScriptTag({content:source});
  for(const name of ['styles.css','workspace.css','workflow_plugins.css'])await page.addStyleTag({content:fs.readFileSync('src/frontend/css/'+name,'utf8')});
  const sql="SELECT TOP 50 e.[ContractNo], e.[ContractDate], e.[EmployeeID], e.[CustomerID], e.[TotalArea], e.[Qty], e.[StartDate], e.[EndDate], e.[StatusID], e.[IsVAT], e.[Note], e.[CompanyID] FROM [dbo].[T_Contract] WHERE e.[ContractNo] = @query";
  for(const dialog of ['wp-business-editor','wp-scope-editor']){
    await page.evaluate(({sql,dialog})=>{
      document.body.innerHTML=`<section class="workflow-modal ${dialog}"><div class="workflow-editor-body"><label><textarea></textarea></label></div></section>`;
      const input=document.querySelector('textarea');input.value=sql;window.testCodeField(input,'sql');
      document.querySelector('section').style.width='520px';
    },{sql,dialog});
    const input=page.locator('textarea');
    const point=await input.evaluate(el=>{const style=getComputedStyle(el),rect=el.getBoundingClientRect(),canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=style.font;const width=context.measureText('M').width;return{x:rect.left+parseFloat(style.paddingLeft)+width*18+width*.1,y:rect.top+parseFloat(style.paddingTop)+parseFloat(style.lineHeight)/2};});
    await page.mouse.click(point.x,point.y);
    assert.equal(await input.evaluate(el=>el.selectionStart),18);
    for(let i=0;i<6;i++)await input.press('Shift+ArrowRight');
    assert.equal(await input.evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd)),sql.slice(18,24));
    await input.press('Backspace');
    assert.equal(await input.inputValue(),sql.slice(0,18)+sql.slice(24));
    assert.equal(await page.locator('.wp-code-line').innerText(),sql.slice(0,18)+sql.slice(24));
    assert.equal(await input.evaluate(el=>getComputedStyle(el,'::selection').color),'rgba(0, 0, 0, 0)');
    await input.press('Control+z');
    assert.equal(await input.inputValue(),sql);
    assert.equal(await page.locator('.wp-code-highlight').evaluate(el=>getComputedStyle(el).whiteSpace),'pre');
    const index=sql.indexOf('CompanyID');
    await input.evaluate((el,index)=>{const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=getComputedStyle(el).font;el.scrollLeft=context.measureText('M').width*index-130;el.dispatchEvent(new Event('scroll'));},index);
    const target=page.locator('.wp-code-identifier').filter({hasText:'CompanyID'}).first();
    const companyPoint=await target.evaluate(el=>{const rect=el.getBoundingClientRect();const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.font=getComputedStyle(el).font;return{x:rect.left+context.measureText('M').width*1.1,y:rect.top+rect.height/2};});
    await page.mouse.click(companyPoint.x,companyPoint.y);
    assert.equal(await input.evaluate(el=>el.selectionStart),index,'Clicking the highlighted CompanyID must place the caret at CompanyID');
    for(let i=0;i<9;i++)await input.press('Shift+ArrowRight');
    assert.equal(await input.evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd)),'CompanyID');
    await input.press('Delete');
    assert.equal(await input.inputValue(),sql.slice(0,index)+sql.slice(index+9));
  }
});
