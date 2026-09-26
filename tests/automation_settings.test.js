'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('explicit environment disable overrides persisted workflow enablement', async t => {
  const automation = require('../src/backend/automation');
  const previous = process.env.WORKFLOW_PLUGINS_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.WORKFLOW_PLUGINS_ENABLED; else process.env.WORKFLOW_PLUGINS_ENABLED = previous; });
  t.mock.method(automation.repository, 'get', async () => ({ id: '_settings', enabled: true, revision: 4 }));
  process.env.WORKFLOW_PLUGINS_ENABLED = 'false';
  assert.equal((await automation.settings()).enabled, false);
  assert.equal((await automation.settings()).disabledByEnvironment, true);
  assert.throws(() => automation.runtime.assertEnabled());
  await assert.rejects(automation.configure({ enabled: true, revision: 4 }, { permissions: ['admin'] }), /WORKFLOW_PLUGINS_ENABLED=false/);
  process.env.WORKFLOW_PLUGINS_ENABLED = 'true';
  assert.equal((await automation.settings()).enabled, true);
  delete process.env.WORKFLOW_PLUGINS_ENABLED;
  assert.equal((await automation.settings()).enabled, true);
});
