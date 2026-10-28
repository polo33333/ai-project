'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/backend/governance/context');
const { check } = require('../src/backend/governance/sql_policy');
const { percentageChange, assemble } = require('../src/backend/governance/evidence');
const { RequestExecutionBudget } = require('../src/backend/agent/harness/request_execution_budget');
const { Admission } = require('../src/backend/governance/admission');

test('request scope fails closed, isolates users/embed, and separates read from model send', () => {
  const resource = { id: 's', governedPolicy: { schemaVersion: 2, access: { mode: 'grants', users: ['account:a'] }, aiSharing: { level: 'local' } } };
  policy.run(() => {
    assert.throws(() => policy.read(resource, 'sql'), { code: 'PRINCIPAL_REQUIRED' });
    policy.setPrincipal({ subject: 'account:b', role: 'user' }); assert.equal(policy.canRead(resource), false);
    policy.setPrincipal({ subject: 'account:a', role: 'user' }); policy.read(resource, 'sql');
    assert.throws(() => policy.assertEgress('external'), { code: 'MODEL_DESTINATION_DENIED' });
    assert.doesNotThrow(() => policy.assertEgress('local-model', true));
    // "Tất cả AI" reaches every provider without naming it; web search is never tied to source policy.
    resource.governedPolicy.aiSharing.level = 'all'; assert.doesNotThrow(() => policy.assertEgress('external'));
    resource.governedPolicy.aiSharing.level = 'off'; assert.throws(() => policy.assertEgress('local-model', true), { code: 'MODEL_DESTINATION_DENIED' });
    assert.doesNotThrow(() => policy.assertEgress('web:https://search.example'));
    resource.governedPolicy.access.users = [];
    assert.throws(() => policy.assertEgress('external'), { code: 'RESOURCE_ACCESS_REVOKED' });
    policy.setPrincipal({ subject: 'embed:w:session', embedId: 'w', channel: 'embed' }); assert.equal(policy.canRead(resource), false);
    resource.governedPolicy.legacyEmbeds = ['w']; assert.equal(policy.canRead(resource), true);
    // A widget reads through the role it was given, like any account.
    policy.setPrincipal({ subject: 'embed:x:session', embedId: 'x', channel: 'embed', role: 'widget_x', permissions: ['sql:read'], grants: { sql: ['s'] } });
    assert.equal(policy.canRead(resource, 'sql'), true);
  });
  policy.run(() => assert.throws(() => policy.principal(), { code: 'PRINCIPAL_REQUIRED' }));
});
test('version 1 policies keep their read decisions and providers can refuse internal data', () => {
  const rules = require('../src/backend/governance/policy');
  const v1 = rules.normalize({ visibility: 'restricted', subjects: ['account:a'], roles: ['finance'], embedIds: ['w'], sensitivity: 'internal', modelDestinations: [] });
  assert.equal(v1.access.mode, 'grants'); assert.equal(v1.aiSharing.level, 'all');
  assert.equal(rules.canRead({ id: 's' }, { subject: 'account:a', role: 'user' }, 'sql', { policy: v1 }), true);
  assert.equal(rules.canRead({ id: 's' }, { subject: 'account:b', role: 'finance' }, 'sql', { policy: v1 }), true);
  assert.equal(rules.canRead({ id: 's' }, { subject: 'account:b', role: 'user' }, 'sql', { policy: v1 }), false);
  assert.equal(rules.normalize({ sensitivity: 'restricted', modelDestinations: [] }).aiSharing.level, 'local');
  const all = rules.normalize(null);
  assert.equal(rules.canSend(all, rules.destination('p1', false, [{ id: 'p1', rejectInternalData: true }])), false);
  assert.equal(rules.canSend({ ...all, aiSharing: { level: 'all', excludeDestinations: ['p2'] } }, rules.destination('p2')), false);
  assert.equal(rules.canSend(all, rules.destination('embedding:model')), true);
  assert.equal(rules.canSend({ ...all, aiSharing: { level: 'local', excludeDestinations: [] } }, rules.destination('mcp:server', true)), false);
  const denied = rules.normalize({ schemaVersion: 2, access: { mode: 'all', denyUsers: ['account:a'] } });
  assert.equal(rules.explain({ id: 's' }, { subject: 'account:a', role: 'user' }, 'sql', { policy: denied }).reason, 'DENIED_USER');
});
test('SQL policy rejects source table/column bypass and direct mutation', () => {
  const source = { governedPolicy: { allowedTables: ['dbo.Orders'], blockedColumns: ['secret'] } };
  assert.equal(check('SELECT id FROM dbo.Orders', source), 'SELECT TOP 100 id FROM dbo.Orders');
  for (const sql of ['SELECT secret FROM dbo.Orders', 'SELECT * FROM dbo.Orders']) assert.throws(() => check(sql, source), { code: 'SQL_COLUMN_DENIED' });
  assert.throws(() => check('SELECT id FROM dbo.Other', source), { code: 'SQL_TABLE_DENIED' });
  assert.throws(() => check('DELETE FROM dbo.Orders', source), { code: 'SQL_READ_ONLY_DENIED' });
});
test('fixed decimal percentage tracks decrease and zero denominator without floating point money arithmetic', () => {
  assert.deepEqual(percentageChange('100.00', '80.00'), { value: '-20.00', unit: '%', direction: 'decrease', rounding: 'truncate_2dp' });
  assert.equal(percentageChange('0', '1').reasonCode, 'ZERO_DENOMINATOR');
  assert.equal(percentageChange('9007199254740993', '9007199254740993').value, '0.00');
});
test('evidence has immutable scope/hash and marks previews without proving answer coverage', () => {
  const evidence = assemble({ toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ amount: 80 }], hasMore: true } }] },
    { requestId: 'r', scopeRef: 'account:a', policyRevision: '1', observedAt: '2026-10-12' });
  assert.equal(evidence.records[0].completeness, 'partial'); assert.equal(evidence.assessment.adequacy, 'undetermined');
  assert.equal(evidence.claims[0].value, 80); assert.equal(evidence.claims[0].assurance, 'source_supported');
  assert.throws(() => { evidence.claims[0].value = 100; }, TypeError);
});
test('parallel usage reservations preserve finalization budget and reconcile only once', () => {
  const budget = new RequestExecutionBudget({ maxTokens: 100, finalizeTokens: 20 });
  const first = budget.reserveUsage({ tokens: 60 });
  assert.throws(() => budget.reserveUsage({ tokens: 30 }), { code: 'TOKEN_BUDGET_EXCEEDED' });
  const final = budget.reserveUsage({ tokens: 40, purpose: 'finalize' });
  budget.reconcileUsage(first, { tokens: 50 }); budget.reconcileUsage(final, { tokens: 30 });
  assert.equal(budget.snapshot().tokens, 80); assert.throws(() => budget.reconcileUsage(first), /UNKNOWN_USAGE/);
});
test('bounded admission cancels queued work and always releases running slots', async () => {
  const gate = new Admission(1, 1), release = await gate.acquire();
  const controller = new AbortController(), pending = gate.acquire({ signal: controller.signal });
  await assert.rejects(gate.acquire(), { code: 'QUEUE_FULL' }); controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(gate.queue.length, 0); release();
  await assert.rejects(gate.run(async () => { throw new Error('failure'); }), /failure/); assert.equal(gate.active, 0);
});
test('answer UI escapes untrusted limitations and keeps pending/error semantics', () => {
  const ui = require('../src/frontend/shared/js/answer_ui');
  assert.equal(ui.render({ schemaVersion: '1', disposition: 'partial' }), '');
  const html = ui.render({ schemaVersion: '1', disposition: 'error', claims: [], limitations: ['<img src=x onerror=alert(1)>'] });
  assert.ok(html.includes('Chưa thể hoàn tất')); assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('Thinking')); assert.ok(!html.includes('timeline'));
});

test('workflow tools bind actor to authenticated conversation and deny write semantics', () => policy.run(() => {
  const workflow = require('../src/backend/governance/workflow_tools');
  policy.setPrincipal({ subject: 'account:a', role: 'user' });
  assert.throws(() => workflow.actor({ session: { accountId: 'b' } }), { code: 'WORKFLOW_PRINCIPAL_MISMATCH' });
  assert.equal(workflow.actor({ session: { accountId: 'a' }, permissions: ['sql:read'] }).accountId, 'a');
  const apiWorkflow = { bindings: { remote: { type: 'api', method: 'POST', effects: 'write' } } };
  assert.doesNotThrow(() => workflow.readOnly(apiWorkflow));
  const previous = process.env.GOVERNED_EXTERNAL_READ_ONLY;
  try {
    process.env.GOVERNED_EXTERNAL_READ_ONLY = 'true';
    assert.throws(() => workflow.readOnly(apiWorkflow), { code: 'READ_ONLY_POLICY_DENIED' });
  } finally {
    if (previous === undefined) delete process.env.GOVERNED_EXTERNAL_READ_ONLY;
    else process.env.GOVERNED_EXTERNAL_READ_ONLY = previous;
  }
}));

test('conversation resources are tainted for model egress and invalidated on policy revision change', () => policy.run(() => {
  const { MemoryService } = require('../src/backend/memory/memory_service');
  const connector = require('../src/backend/services/sql_connector');
  const resource = { id: 'memory-fixture', governedPolicy: { visibility: 'shared', revision: 1, sensitivity: 'restricted' } };
  connector.dbSources.push(resource); policy.setPrincipal({ subject: 'account:a', role: 'user' }); policy.read(resource, 'sql');
  const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
  try {
    memory.persistSuccessfulExchange({ sessionId: 's', accountId: 'a', question: 'value', reply: '80', completionStatus: 'SUCCESS', responseEvaluation: { valid: true } });
    assert.ok(memory.getSession('s', false, 'a'));
    assert.throws(() => policy.assertEgress('external'), { code: 'MODEL_DESTINATION_DENIED' });
    resource.governedPolicy.revision = 2; assert.equal(memory.getSession('s', false, 'a'), null);
    assert.equal(memory.clearSession('s', 'a'), true);
  } finally { connector.dbSources = connector.dbSources.filter(item => item.id !== resource.id); }
}));
