'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
test('historical workflow restore uses at most two concurrent requests and skips hidden panels', async () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/workflow_plugins.js', 'utf8');
  let active = 0, peak = 0, calls = 0, mounted = 0;
  const panel = (id, visible = true) => ({ dataset: { automationRun: id }, isConnected: true,
    getClientRects: () => visible ? [{}] : [], querySelector: () => null, querySelectorAll: () => [], setAttribute() {} });
  const panels = Array.from({ length: 12 }, (_, i) => panel('run-' + i));
  panels.push(panel('hidden-run', false));
  const context = { window: {}, views: new Map(), restoringRuns: new Map(), restoringPanels: new WeakSet(),
    api: async () => { calls++; active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return { execution: {} }; },
    mount: () => { mounted++; } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  window.restoreWorkflowExecutions ='), source.indexOf('  // Rehydrate saved chat HTML')), context);
  await context.window.restoreWorkflowExecutions({ querySelectorAll: () => panels });
  assert.equal(calls, 12); assert.equal(mounted, 12); assert.equal(peak, 2);
  assert.equal(context.restoringRuns.size, 0);
});
