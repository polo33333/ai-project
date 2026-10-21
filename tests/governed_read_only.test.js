'use strict';
process.env.GOVERNED_READ_ONLY = 'true';
process.env.GOVERNED_EXTERNAL_READ_ONLY = 'true';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('../src/backend/automation/read_only_policy');

test('external APIs use configured methods by default independently of SQL read-only', t => {
  const previous = process.env.GOVERNED_EXTERNAL_READ_ONLY;
  t.after(() => { process.env.GOVERNED_EXTERNAL_READ_ONLY = previous; });
  delete process.env.GOVERNED_EXTERNAL_READ_ONLY;
  assert.equal(policy.enabled(), true);
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotThrow(() => policy.assertSourceAllowed({ type: 'api', method }));
  }
});

test('read-only policy rejects writes and unreviewed GET semantics regardless of admin role', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET']) {
    assert.throws(() => policy.assertSourceAllowed({ type: 'api', method }), { code: 'READ_ONLY_POLICY_DENIED' });
  }
  assert.throws(() => policy.assertSourceAllowed({ type: 'api', method: 'POST', effects: 'read' }), { code: 'READ_ONLY_POLICY_DENIED' });
  assert.doesNotThrow(() => policy.assertSourceAllowed({ type: 'api', method: 'GET', effects: 'read' }));
  assert.doesNotThrow(() => policy.assertSourceAllowed({ type: 'sql' }));
});

test('direct API and legacy HTTP workflow paths cannot bypass the read-only gate', async () => {
  const api = require('../src/backend/automation/api_http');
  await assert.rejects(api.readApi({ url: 'https://example.invalid', method: 'POST' }, {}), { code: 'READ_ONLY_POLICY_DENIED' });
  const { createStep } = require('../src/backend/agent_core/workflows/automation_steps');
  const step = createStep({ id: 'write', type: 'http', config: { url: 'https://example.invalid', method: 'DELETE' } });
  await assert.rejects(step.execute({}, { permissions: ['admin'] }), { code: 'READ_ONLY_POLICY_DENIED' });
});

test('durable runtime enforces policy before an injected source executor can send a write', async t => {
  const { AutomationRepository } = require('../src/backend/automation/repository');
  const { AutomationRuntime } = require('../src/backend/automation/runtime');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'governed-read-only-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new AutomationRepository({ directory }); let sent = false;
  const runtime = new AutomationRuntime(repository, { canContinue: async () => true }, {
    enabled: () => true, authorizeContext: async () => ({ accountId: 'admin', permissions: ['admin'] }),
    executeSource: async () => { sent = true; return {}; }
  });
  await repository.put('runs', { id: 'blocked', ownerId: 'admin', status: 'READY', input: {}, outputs: {}, attempts: {},
    nextIndex: 0, artifacts: [], events: [], definition: {
      bindings: { target: { type: 'api', url: 'https://example.invalid', method: 'POST' } },
      workflow: { steps: [{ id: 'send', type: 'source', config: { bindingRef: 'target' } }] }
    } });
  await runtime.process('blocked');
  assert.equal(sent, false); assert.equal((await repository.get('runs', 'blocked')).status, 'FAILED');
});
