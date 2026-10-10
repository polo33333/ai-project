'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

for (const staleRestoring of [false, true]) {
  test(`saved result retry survives rehydration${staleRestoring ? ' with a stale restoring marker' : ''}`, { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async t => {
    const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
    const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: staleRestoring ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
    page.setDefaultTimeout(5000);
    const failures = []; page.on('pageerror', error => failures.push(error.message));
    await page.route('http://localhost:12345/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.goto('http://localhost:12345/');
    const install = async html => {
      await page.addStyleTag({ content: fs.readFileSync(path.resolve('src/frontend/css/workflow_plugins.css'), 'utf8') });
      await page.evaluate(({ html, dark }) => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
        document.querySelector('main').innerHTML = html;
        const completed = { id: 'saved-report', templateId: 'fixture/report', conversationId: 'fixture-chat', name: 'Saved report', status: 'SUCCEEDED', revision: 2, result: { value: 'completed' }, steps: [] };
        window.reads = 0; window.retryRequests = [];
        window.fetch = async (url, options = {}) => {
          if (options.method === 'POST') {
            const body = JSON.parse(options.body); window.retryRequests.push(body);
            return { ok: true, json: async () => ({ execution: { ...completed, id: 'retry-report', parentRunId: body.parentRunId, status: 'WAITING_INPUT', result: null,
              missingInputs: [{ key: 'query', label: 'Identifier', schema: { type: 'string' } }] } }) };
          }
          window.reads++;
          await new Promise(resolve => setTimeout(resolve, 100));
          return { ok: true, json: async () => ({ execution: completed }) };
        };
        // Page chat serializes the bubble synchronously in this event handler.
        document.querySelector('article').addEventListener('workflow-execution-updated', event => {
          window.savedReply = event.currentTarget.outerHTML;
        });
      }, { html, dark: staleRestoring });
      await page.addScriptTag({ content: fs.readFileSync(path.resolve('src/frontend/js/modules/workflow_plugins.js'), 'utf8') });
      await page.evaluate(() => Promise.all([window.restoreWorkflowExecutions(document), window.restoreWorkflowExecutions(document)]));
    };
    await install(`<article><div class="workflow-execution-panel" data-automation-run="saved-report"${staleRestoring ? ' data-restoring="true"' : ''}><strong>Saved report</strong><button type="button">Làm lại</button></div></article>`);
    assert.equal(await page.evaluate(() => window.reads), 1, 'Restoration uses a live request, not a persisted DOM loading marker, and deduplicates concurrent calls');
    const saved = await page.evaluate(() => window.savedReply);
    assert.ok(saved && !saved.includes('data-restoring'), 'History must not serialize transient restoration state');
    await page.reload();
    await install(saved);
    await page.getByRole('button', { name: 'Làm lại', exact: true }).click();
    await page.locator('[data-automation-run="retry-report"] input').waitFor();
    const requests = await page.evaluate(() => window.retryRequests);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].parentRunId, 'saved-report');
    assert.equal(requests[0].conversationId, 'fixture-chat');
    assert.equal(requests[0].templateId, 'fixture/report');
    assert.ok(requests[0].requestId);
    assert.deepEqual(failures, []);
  });
}

test('repeated messages keep one actionable panel per run and archived panels survive reload', { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async t => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('http://localhost:12345/**', route => route.fulfill({ contentType: 'text/html', body: '<main id="messages"></main>' }));
  await page.goto('http://localhost:12345/');
  const source = fs.readFileSync(path.resolve('src/frontend/js/modules/workflow_plugins.js'), 'utf8');
  const install = async () => {
    await page.evaluate(() => {
      window.testRun = { id: 'same-run', templateId: 'report', conversationId: 'chat', name: 'Report', status: 'WAITING_INPUT', revision: 1, missingInputs: [{ key: 'query', label: 'Identifier', ask: 'Which identifier?', schema: { type: 'string' } }], steps: [] };
      window.submissions = 0;
      window.retryCreates = 0;
      window.fetch = async (url, options = {}) => {
        if (options.method === 'POST' && url === '/api/automation-runs') {
          window.retryCreates++;
          await new Promise(resolve => setTimeout(resolve, 300));
          const body = JSON.parse(options.body);
          if (body.parentRunId !== 'same-run') throw Error('Missing retry parent');
          window.parentRun = { ...window.testRun, retryRunId: 'retry-child', retryWaitingInput: true };
          window.testRun = { ...window.testRun, id: 'retry-child', parentRunId: body.parentRunId, status: 'WAITING_INPUT', missingInputs: [{ key: 'query', label: 'Identifier', ask: 'Which identifier?', schema: { type: 'string' } }], result: null };
        } else if (options.method === 'POST') { window.submissions++; window.testRun = { ...window.testRun, revision: 2, status: 'SUCCEEDED', missingInputs: [], result: { value: 'completed' } }; if (window.parentRun) window.parentRun.retryWaitingInput = false; }
        return { ok: true, json: async () => ({ execution: url.endsWith('/same-run') && window.parentRun ? window.parentRun : window.testRun }) };
      };
    });
    await page.addScriptTag({ content: source });
  };
  await install();
  await page.evaluate(() => {
    for (let i = 0; i < 2; i++) document.querySelector('main').insertAdjacentHTML('beforeend', `<article>${window.renderWorkflowExecution(window.testRun)}</article>`);
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-execution-archived]').length === 1);
  assert.equal(await page.locator('form').count(), 1);
  await page.locator('form input').fill('A001');
  await page.locator('form button[type="submit"]').click();
  await page.waitForFunction(() => window.submissions === 1 && document.querySelectorAll('form').length === 0);
  assert.equal(await page.locator('[data-execution-archived] form').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 1, 'Duplicate panels for one run expose only one retry action');
  const saved = await page.locator('main').innerHTML();
  await page.reload();
  await install();
  await page.evaluate(html => { document.querySelector('main').innerHTML = html; return window.restoreWorkflowExecutions(document); }, saved);
  assert.equal(await page.locator('[data-execution-archived]').count(), 1);
  assert.equal(await page.locator('form').count(), 1);
  await page.getByRole('button', { name: '\u0110\u1ebfn form hi\u1ec7n t\u1ea1i' }).click();
  assert.equal(await page.evaluate(() => window.submissions), 0);
  await page.locator('form input').fill('A002');
  await page.locator('form button[type="submit"]').click();
  const original = page.locator('[data-automation-run="same-run"]:not([data-execution-archived])');
  await original.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).click();
  assert.equal(await original.getByRole('button', { name: 'Đang mở form…', exact: true }).isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-automation-run="retry-child"] input'));
  assert.equal(await page.evaluate(() => window.retryCreates), 1, 'One click creates the retry form');
  assert.equal(await original.getAttribute('data-collapsed'), 'true', 'Retry collapses the previous card in the same reply');
  assert.equal(await original.locator('.wp-execution-fold').getAttribute('aria-expanded'), 'false');
  assert.notEqual(await page.locator('[data-automation-run="retry-child"]').getAttribute('data-collapsed'), 'true', 'The new retry form remains expanded');
  assert.equal(await original.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 0);
  await page.locator('[data-automation-run="retry-child"] input').fill('A003');
  await page.locator('[data-automation-run="retry-child"] button[type="submit"]').click();
  assert.equal(await original.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 1, 'Only the latest retry child exposes the retry action');
  await page.evaluate(() => document.querySelector('main').insertAdjacentHTML('beforeend', window.renderWorkflowExecution({ ...window.testRun, id: 'independent', parentRunId: null, retryRunId: null })));
  await page.waitForFunction(() => document.querySelector('[data-automation-run="independent"] strong'));
  assert.equal(await page.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 2, 'An independent run keeps its own retry action');
});

test('embed repeated requests keep one input panel and reload restores one run', { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async t => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const source = fs.readFileSync(path.resolve('src/frontend/embed/knowledgehub-chat.js'), 'utf8');
  let inputs = 0;
  let child = null;
  const run = { id: 'same-run', name: 'Report', templateId: 'report', conversationId: 'chat', status: 'WAITING_INPUT', revision: 1, missingInputs: [{ key: 'query', ask: 'Identifier?', schema: { type: 'string' } }] };
  await page.route('http://localhost:12345/**', async route => {
    const url = route.request().url();
    if (url.endsWith('/embed.js')) return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: source });
    if (url.endsWith('/api/embed/chat')) {
      const body = route.request().postDataJSON();
      if (body.workflowAction === 'create') {
        assert.equal(body.parentRunId, run.id);
        child = { ...run, id: 'retry-child', parentRunId: run.id, status: 'WAITING_INPUT', result: null };
        run.retryRunId = child.id; run.retryWaitingInput = true;
      }
      const selected = ((child && body.runId === child.id) || body.workflowAction === 'create') ? child : run;
      if (body.workflowAction === 'inputs') { inputs++; selected.status = 'SUCCEEDED'; selected.revision++; selected.result = { value: 'completed' }; if (selected === child) run.retryWaitingInput = false; }
      return route.fulfill({ json: { status: 'success', execution: selected, workflowToken: 'fixture-token' } });
    }
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><body><script src="/embed.js" data-embed-id="fixture"></script></body></html>' });
  });
  await page.goto('http://localhost:12345/');
  assert.deepEqual(failures, []);
  const host = page.locator('#knowledgehub-embed-host');
  await host.getByRole('button', { name: 'M\u1edf tr\u1ee3 l\u00fd AI', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await host.getByLabel('C\u00e2u h\u1ecfi', { exact: true }).fill('Report');
    await host.getByRole('button', { name: 'G\u1eedi', exact: true }).click();
    await page.waitForFunction(expected => document.querySelector('#knowledgehub-embed-host').shadowRoot.querySelectorAll('.kh-workflow').length === expected, i + 1);
  }
  assert.equal(await host.locator('.kh-workflow input').count(), 1);
  assert.equal(await host.locator('[data-workflow-archived]').count(), 1);
  await host.locator('.kh-workflow input').fill('A001');
  await host.getByRole('button', { name: 'B\u1ed5 sung v\u00e0 ti\u1ebfp t\u1ee5c', exact: true }).click();
  await host.getByText('completed', { exact: true }).waitFor();
  assert.equal(inputs, 1);
  assert.equal(await host.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 1, 'Duplicate embed panels for the same run expose one retry action');
  await page.reload();
  await host.getByRole('button', { name: 'M\u1edf tr\u1ee3 l\u00fd AI', exact: true }).click();
  await host.getByText('completed', { exact: true }).waitFor();
  assert.equal(await host.locator('.kh-workflow').count(), 1);
  assert.equal(inputs, 1);
  await host.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).click();
  await host.locator('.kh-workflow input').waitFor();
  assert.equal(await host.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 0);
  await page.reload();
  await host.getByRole('button', { name: 'M\u1edf tr\u1ee3 l\u00fd AI', exact: true }).click();
  await host.locator('.kh-workflow input').waitFor();
  assert.equal(await host.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 0);
  await host.locator('.kh-workflow input').fill('A002');
  await host.getByRole('button', { name: 'B\u1ed5 sung v\u00e0 ti\u1ebfp t\u1ee5c', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelector('#knowledgehub-embed-host').shadowRoot.querySelectorAll('button')].filter(button => button.textContent === 'L\u00e0m l\u1ea1i' && !button.disabled).length === 1);
  assert.equal(inputs, 2);
  assert.equal(await host.getByRole('button', { name: 'L\u00e0m l\u1ea1i', exact: true }).count(), 1, 'Only the latest completed child has a retry action in the embed');
});

test('refresh restores waiting forms without waiting for historical cards and deduplicates run requests', { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async t => {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(os.tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.route('http://localhost:12345/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto('http://localhost:12345/');
  await page.evaluate(() => {
    window.runRequests = [];
    window.inputSubmissions = 0;
    const waiting = { id: 'waiting', templateId: 'report', conversationId: 'chat', name: 'Waiting form', status: 'WAITING_INPUT', revision: 1,
      missingInputs: [{ key: 'query', label: 'Identifier', schema: { type: 'string' } }], steps: [] };
    window.fetch = async (url, options = {}) => {
      if (options.method === 'POST') {
        window.inputSubmissions++;
        return { ok: true, json: async () => ({ execution: { ...waiting, revision: 2, status: 'SUCCEEDED', missingInputs: [] } }) };
      }
      window.runRequests.push(url);
      if (url.endsWith('/historical')) return new Promise(resolve => { window.releaseHistory = () => resolve({ ok: true, json: async () => ({ execution: { id: 'historical', name: 'History', status: 'SUCCEEDED', revision: 1, steps: [] } }) }); });
      return { ok: true, json: async () => ({ execution: waiting }) };
    };
    document.querySelector('main').innerHTML = '<article><div class="workflow-execution-panel" data-automation-run="historical"><strong>History</strong><button>Old action</button></div><div class="workflow-execution-panel" data-automation-run="waiting"><strong>Saved form</strong><form><input><button type="submit">Continue</button></form></div></article><article><div class="workflow-execution-panel" data-automation-run="waiting"><strong>Newer saved form</strong><form><input><button type="submit">Continue</button></form></div></article>';
  });
  await page.addScriptTag({ content: fs.readFileSync(path.resolve('src/frontend/js/modules/workflow_plugins.js'), 'utf8') });
  await page.evaluate(() => { window.restorePromise = window.restoreWorkflowExecutions(document); });
  await page.waitForFunction(() => document.querySelector('[data-automation-run="waiting"]:not([data-execution-archived]) form')?.onsubmit);
  assert.equal(await page.locator('[data-automation-run="historical"]').getAttribute('data-restoring'), 'true', 'History is still loading when the form becomes usable');
  assert.equal(await page.evaluate(() => window.runRequests.filter(url => url.endsWith('/waiting')).length), 1, 'Duplicate panels share one owner-checked request');
  assert.equal(await page.locator('form').count(), 1);
  await page.locator('form input').fill('A001');
  await page.locator('form button[type="submit"]').click();
  assert.equal(await page.evaluate(() => window.inputSubmissions), 1, 'Submit works before history finishes loading');
  await page.evaluate(async () => { window.releaseHistory(); await window.restorePromise; });
});
