'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const bundle = require('../docs/templates/electricity_sales_seven_months.json');
const { validatePackage, resolve, condition, validateInputs } = require('../src/backend/automation/contract');
const { executePure, AutomationRuntime } = require('../src/backend/automation/runtime');
const { PluginRegistry } = require('../src/backend/automation/registry');
test('seven month electricity template validates and runs all nodes with Excel output', async () => {
  validatePackage(bundle);
  assert.equal((await new PluginRegistry(null).testBundle(bundle)).passed, true);
  const template = bundle.templates[0];
  const state = { input: { months: 7, drawChart: true, exportFile: true }, steps: {} };
  const runtime = new AutomationRuntime(null, null);
  for (const step of template.workflow.steps) {
    state.steps[step.id] = step.type === 'sql' ? template.fixtures[0].stepResults.query : step.type === 'export' ? await runtime.export(step, state, {}) : await executePure(step, state);
  }
  const result = resolve(template.output.mapping, state);
  assert.equal(result.chart.points.length, 7);
  assert.equal(result.chart.points[0].value, 1000);
  const artifact = state.steps.export.artifact;
  const file = require('node:path').join(process.env.KNOWLEDGEHUB_EXPORT_DIR, 'automation', artifact.storageName);
  const xlsx = require('xlsx');
  assert.deepEqual(xlsx.utils.sheet_to_json(xlsx.readFile(file).Sheets.Data), result.rows);
  fs.unlinkSync(file);
});
test('chart rejects missing and invalid metrics rather than plotting misleading zeroes', async () => {
  for (const value of [null, undefined, NaN, -1, '10']) {
    await assert.rejects(executePure({ type: 'chart', config: { data: [{ month: '2026-01', qty: value }], x: 'month', y: 'qty' } }, {}));
  }
  const chart = await executePure({ type: 'chart', config: { data: [{ month: '2026-01', qty: 0 }], x: 'month', y: 'qty' } }, {});
  assert.equal(chart.points[0].value, 0);
});
test('two available months and empty DB remain unpadded through export', async () => {
  const template = bundle.templates[0];
  for (const rows of [template.fixtures[0].stepResults.query.rows.slice(0, 2), []]) {
    const state = { input: { months: 7, drawChart: true, exportFile: true }, steps: {} }, runtime = new AutomationRuntime(null, null);
    for (const step of template.workflow.steps) state.steps[step.id] = step.type === 'sql' ? { rows, rowCount: rows.length } : step.type === 'export' ? await runtime.export(step, state, {}) : await executePure(step, state);
    const result = resolve(template.output.mapping, state);
    assert.equal(result.chart.points.length, rows.length);
    assert.deepEqual(result.rows, rows);
    assert.deepEqual(require('../src/backend/automation/contract').validateValue(result, template.output.schema), []);
    if (!rows.length) assert.equal(state.steps.export.artifact, undefined);
    else fs.unlinkSync(require('node:path').join(process.env.KNOWLEDGEHUB_EXPORT_DIR, 'automation', state.steps.export.artifact.storageName));
  }
});
test('report collects only missing choices, accepts false, and skips unwanted chart/export', async () => {
  const template = bundle.templates[0];
  assert.deepEqual(validateInputs(template, {}).missing.map(slot => slot.key), ['months', 'drawChart', 'exportFile']);
  assert.deepEqual(validateInputs(template, { months: 7, drawChart: false }).missing.map(slot => slot.key), ['exportFile']);
  assert.equal(validateInputs(template, { months: 0, drawChart: false, exportFile: false }).valid, false);
  for (const drawChart of [true, false]) for (const exportFile of [true, false]) {
    const state = { input: { months: 2, drawChart, exportFile }, steps: {} };
    assert.equal(validateInputs(template, state.input).valid, true);
    const runtime = new AutomationRuntime(null, null), rows = template.fixtures[0].stepResults.query.rows.slice(0, 2);
    for (const step of template.workflow.steps) {
      if (!condition(step.when, state)) continue;
      state.steps[step.id] = step.type === 'sql' ? { rows, rowCount: rows.length } : step.type === 'export' ? await runtime.export(step, state, {}) : await executePure(step, state);
    }
    assert.equal(Boolean(state.steps.chart), drawChart);
    assert.equal(Boolean(state.steps.export?.artifact), exportFile);
    const result = resolve(template.output.mapping, state);
    assert.deepEqual(require('../src/backend/automation/contract').validateValue(result, template.output.schema), []);
    if (exportFile) fs.unlinkSync(require('node:path').join(process.env.KNOWLEDGEHUB_EXPORT_DIR, 'automation', state.steps.export.artifact.storageName));
  }
});
test('browser draws columns, axes, zero markers and empty message', { skip: process.env.KNOWLEDGEHUB_TEST_BROWSER !== '1' }, async () => {
  const path = require('node:path');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || path.join(require('node:os').tmpdir(), 'knowledgehub-phase1-ui-tools/node_modules/playwright'));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/workflow_plugins.js'), 'utf8');
    await page.evaluate('(() => {' + source.slice(source.indexOf('  function resultText('), source.indexOf('  function mount(')) + '; window.renderResult = renderResult; })()');
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../src/frontend/css/workflow_plugins.css'), 'utf8') });
    for (const values of [[1000, 2000], [0, 0], []]) {
      await page.evaluate(values => document.body.replaceChildren(window.renderResult({ kind: 'bar-chart', title: 'Test', unit: 'kWh', points: values.map((value, i) => ({ label: `2024-0${i + 1}`, value })) })), values);
      assert.equal(await page.locator('svg rect').count(), values.length);
      if (values.length) {
        assert.equal(await page.locator('svg path').count(), 1);
        assert.equal(await page.locator('svg circle').count(), values[0] === 0 ? 2 : 0);
        assert.ok((await page.locator('svg').boundingBox()).height > 100);
        assert.equal(await page.locator('svg').evaluate(svg => getComputedStyle(svg).backgroundColor), 'rgb(255, 255, 255)');
        await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
        assert.equal(await page.locator('svg').evaluate(svg => getComputedStyle(svg).backgroundColor), 'rgb(30, 41, 59)');
        assert.equal(await page.locator('svg text').first().evaluate(text => getComputedStyle(text).fill), 'rgb(181, 195, 216)');
        assert.equal(await page.locator('svg rect').first().evaluate(rect => getComputedStyle(rect).fill), 'rgb(96, 165, 250)');
        await page.evaluate(() => document.documentElement.dataset.theme = 'light');
      } else assert.match(await page.locator('figure').innerText(), /Không có dữ liệu/);
    }
  } finally { await browser.close(); }
});
