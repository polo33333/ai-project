'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('embed workflow renders chart objects as SVG at widget width', { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async () => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(require('node:os').tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
    const source = fs.readFileSync(path.join(__dirname, '../src/frontend/embed/knowledgehub-chat.js'), 'utf8');
    const escape = source.slice(source.indexOf('  const escapeHtml ='), source.indexOf('\n', source.indexOf('  const escapeHtml =')));
    const charts = source.slice(source.indexOf('  const chartColors ='), source.indexOf('  const renderEmbedCitations ='));
    const mount = source.slice(source.indexOf('  function mountWorkflow('), source.indexOf('  // Keep host-page keyboard'));
    await page.evaluate(`(() => { ${escape}\n${charts}\n const workflowRuns=[]; const saveWorkflow=()=>{}; const formatDisplayValue=v=>String(v); const createSessionId=()=> 'test'; ${mount}\n window.mountWorkflow=mountWorkflow; })()`);
    await page.setContent('<style>.kh-embed-chart svg{display:block;width:100%;height:auto}</style><div id="result" style="width:280px"></div>');
    const render = points => page.evaluate(points => window.mountWorkflow(document.querySelector('#result'), { status: 'SUCCEEDED', name: 'Report', result: { chart: { kind: 'bar-chart', title: '<img src=x onerror=alert(1)>', unit: 'kWh', points } } }), points);
    await render([{ label: '2024-01', value: 3322035 }, { label: '2024-02', value: 1868033 }]);
    assert.equal(await page.locator('svg rect').count(), 2);
    assert.equal(await page.locator('#result img').count(), 0);
    assert.doesNotMatch(await page.locator('#result').innerText(), /\[object Object\]/);
    assert.match(await page.locator('svg').getAttribute('aria-label'), /kWh/);
    assert.ok((await page.locator('svg').boundingBox()).width <= 280);
    await render([]);
    assert.equal(await page.locator('svg').count(), 0);
    assert.match(await page.locator('#result').innerText(), /Không có dữ liệu/);
  } finally { await browser.close(); }
});
