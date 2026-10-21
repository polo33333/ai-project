'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { discover } = require('../src/backend/governance/workflow_discovery');
const definitions = Array.from({ length: 50 }, (_, i) => ({ id: `test/${i}`, name: `Quy trình ${i}`,
  description: `Nghiệp vụ số ${i}`, instructions: 'Hướng dẫn dài. '.repeat(100),
  inputs: { code: { label: 'Mã', required: true, ask: 'Cung cấp mã cần tra cứu' } }, tags: ['operation:detail'] }));
test('50 definitions remain reachable with bounded summaries and much smaller payload', () => {
  const result = discover(definitions);
  assert.equal(result.workflows.length, 5);
  assert.equal(result.directory.length, 50);
  assert.equal(result.nextOffset, 5);
  assert.ok(result.workflows.every(item => !('instructions' in item)));
  const seen = new Set();
  for (let offset = 0; offset < 50; offset += 5) discover(definitions, { offset }).workflows.forEach(w => seen.add(w.templateId));
  assert.equal(seen.size, 50);
  assert.ok(JSON.stringify(result).length < JSON.stringify(definitions).length / 3);
});
test('ranking never excludes candidates or requires input values; details fetched on demand', () => {
  const catalog = structuredClone(definitions);
  catalog[49].name = 'Tra cứu hợp đồng';
  const result = discover(catalog, { query: 'Tra cứu hợp đồng' });
  assert.equal(result.workflows[0].templateId, 'test/49');
  assert.equal(result.workflows[0].inputs.code.ask, 'Cung cấp mã cần tra cứu');
  assert.equal(result.directory.length, 50);
  assert.equal(discover(catalog, { templateId: 'test/49' }).workflows[0].instructions, catalog[49].instructions);
  assert.throws(() => discover(catalog, { templateId: 'unauthorized' }), /WORKFLOW_NOT_AVAILABLE/);
  assert.equal(discover(catalog, { query: 'không khớp' }).total, 50);
});
test('large catalogs keep pending input state and never cache an incomplete shortlist', async t => {
  const governance = require('../src/backend/governance/context');
  const automation = require('../src/backend/automation');
  const workflows = require('../src/backend/governance/workflow_tools');
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:discovery-owner', role: 'user' });
    t.mock.method(automation, 'settings', async () => ({ enabled: true }));
    t.mock.method(automation.registry, 'list', async () => definitions);
    t.mock.method(automation.runtime, 'pending', async () => ({ id: 'pending', templateId: 'test/49', status: 'WAITING_INPUT', revision: 1, missing: [{ key: 'code', ask: 'Cung cấp mã' }] }));
    const context = { session: { id: 'discovery-50', accountId: 'discovery-owner' }, permissions: ['sql:read'] };
    const result = await workflows.execute('list_workflows', {}, context);
    assert.equal(result.workflows.length, 5);
    assert.equal(result.pendingRuns[0].missingInputs[0].key, 'code');
    assert.equal(await workflows.cachedCatalog(context), null);
    assert.equal((await workflows.execute('list_workflows', { templateId: 'test/49' }, context)).workflows[0].templateId, 'test/49');
    await assert.rejects(workflows.execute('list_workflows', { templateId: 'private' }, context), /WORKFLOW_NOT_AVAILABLE/);
  });
});
