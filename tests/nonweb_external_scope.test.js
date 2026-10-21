'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('independent external-current question discards stale SQL requirements and suggests web', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager;
  let calls = 0;
  const harness = new Harness({ toolManager: manager, dispatch: async () => {
    calls++;
    return { content: JSON.stringify({ sourceScope: 'external_current', relation: 'independent', operation: 'conversation', cardinality: 'none', attributes: [], selectedIds: [], clarification: '', dataUse: 'none' }) };
  } });
  const result = await harness.run({ userMessage: 'current public price', provider: { id: 'fixture', supportsToolCalling: true }, context: {
    governedController: true, lockProvider: true, permissions: ['admin'], mode: 'general',
    requestPlan: { table: 'OldBusinessTable', schemaColumns: ['PrivateColumn'], intent: 'list', outputs: { data: true } },
    resolutionContext: { recent: [{ role: 'user', content: 'previous business report' }], candidates: [] }
  } });
  assert.equal(calls, 1);
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.match(result.replyText, /bật Tìm kiếm web/);
  assert.ok(!result.replyText.includes('PrivateColumn'));
  assert.equal(result.trace.training.plan.table, null);
  assert.equal(result.trace.training.plan.requestContract, null);
});
