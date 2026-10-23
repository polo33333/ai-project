'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const capabilities = require('../src/backend/automation/workflow_capabilities');
function report() { return { id: 'test/report', name: 'Monthly quantity report', description: 'Monthly quantity from latest available data with optional chart/export.',
  allowedCapabilities: ['sql.read','data.transform','data.chart','artifact.export'],
  inputs: { months: { required: true, schema: { type: 'integer', minimum: 1, maximum: 100 } }, drawChart: { required: true, schema: { type: 'boolean' } }, exportFile: { required: true, schema: { type: 'boolean' } } },
  bindings: { source: { sql: 'SELECT P, SUM(Q) AS Qty FROM TestRows GROUP BY P' } },
  workflow: { steps: [{ id: 'query', type: 'sql', config: { bindingRef: 'source' } }, { id: 'chart', type: 'chart', config: {} },
    { id: 'export', type: 'export', config: {} }, { id: 'result', type: 'transform', config: { mapping: { chart: '{{steps.chart}}', filename: '{{steps.export.filename}}' } } }] },
  output: { mapping: { chart: '{{steps.result.chart}}', filename: '{{steps.result.filename}}' } } }; }
test('published executable steps establish report/chart/export capabilities without operation tags', () => {
  assert.deepEqual(capabilities.operations(report()).sort(), ['aggregate','chart','export']);
  const hidden = report(); hidden.output.mapping = { count: 1 };
  assert.deepEqual(capabilities.operations(hidden), ['aggregate']);
  const undeclared = report(); undeclared.allowedCapabilities = ['sql.read'];
  assert.deepEqual(capabilities.operations(undeclared), ['aggregate']);
  assert.deepEqual(capabilities.operations({ name: 'chart export', tags: ['biểu đồ'], output: { mapping: { chartCapability: true } } }), []);
});
test('workflow chooser keeps missing slots missing and never treats absent export as false', async () => {
  const { choose } = require('../src/backend/memory_core/workflow_preference');
  const d = report(), question = 'vẽ biểu đồ trong 7 tháng';
  const chosen = await choose(async () => ({ content: JSON.stringify({ templateId: d.id,
    inputs: { months: 7, drawChart: true, exportFile: false }, evidence: { months: '7', drawChart: 'vẽ biểu đồ' } }) }), question,
    [{ templateId: d.id, inputs: d.inputs }]);
  assert.deepEqual(chosen.inputs, { months: 7, drawChart: true });
});
test('pending workflow accepts an explicit false answer and exposes only missing inputs', async t => {
  const governance = require('../src/backend/governance/context'), automation = require('../src/backend/automation');
  const tools = require('../src/backend/governance/workflow_tools'), d = report();
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'canContinue', async () => true);
  t.mock.method(automation.runtime, 'pending', async (identity, conversationId) => {
    assert.equal(identity.accountId, 'pending-owner'); assert.equal(conversationId, 'pending-chat');
    return { id: 'pending-run', templateId: d.id, definition: d, revision: 4, status: 'WAITING_INPUT', missing: [{ key: 'exportFile' }] };
  });
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:pending-owner', role: 'admin' });
    const pending = await tools.pendingInput({ session: { id: 'pending-chat', accountId: 'pending-owner' } });
    assert.deepEqual(Object.keys(pending.inputs), ['exportFile']);
    const chosen = await require('../src/backend/memory_core/workflow_preference').choose(async (defs, messages) => {
      assert.match(messages.at(-2).content, /new business request/);
      return { content: JSON.stringify({ templateId: d.id, inputs: { exportFile: false, months: 2 }, evidence: { exportFile: 'không xuất file', months: 'không' } }) };
    }, 'không xuất file', [pending], true);
    assert.deepEqual(chosen.inputs, { exportFile: false });
    assert.equal(pending.runId, 'pending-run'); assert.equal(pending.revision, 4);
  });
});
test('matching workflow is preferred before SQL and unconfirmed boolean is left for runtime', async t => {
  const governance = require('../src/backend/governance/context'), automation = require('../src/backend/automation');
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager, d = report();
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [d]);
  t.mock.method(automation.registry, 'getTemplate', async () => d);
  t.mock.method(automation.runtime, 'pending', async () => null);
  let created, sqlCalls = 0;
  t.mock.method(automation.runtime, 'create', async (id, inputs) => { created = { id, inputs }; return { id: 'test-run', status: 'WAITING_INPUT', missingInputs: [{ key: 'exportFile', ask: 'Export?' }] }; });
  t.mock.method(manager.getTool('execute_sql_query'), 'run', async () => { sqlCalls++; throw new Error('Manual SQL must not run'); });
  const call = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const harness = new Harness({ toolManager: manager, dispatch: async (provider, messages, definitions) => {
    const name = definitions[0]?.function.name;
    if (name === 'choose_workflow') return call(name, { templateId: d.id, inputs: { months: 7, drawChart: true, exportFile: false },
      evidence: { months: '7', drawChart: 'vẽ biểu đồ', exportFile: '7' } });
    if (name === 'assess_workflow') return call(name, { suitable: true, reason: 'Exact report', confirmedSlots: ['months','drawChart'] });
    return call('list_workflows', {});
  } });
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:priority-owner', role: 'admin' });
    const result = await harness.run({ userMessage: 'vẽ biểu đồ trong 7 tháng', provider: { id: 'test', supportsToolCalling: true },
      enabledToolNames: ['list_workflows','run_workflow','search_schema','execute_sql_query'],
      context: { governedController: true, lockProvider: true, permissions: ['admin'], session: { id: 'priority-test', accountId: 'priority-owner' },
        requestPlan: { outputs: { data: true, chart: true } }, mode: 'data' } });
    assert.equal(created.id, d.id);
    assert.deepEqual(created.inputs, { months: 7, drawChart: true });
    assert.equal(sqlCalls, 0);
    assert.deepEqual(result.toolCalls.map(item => item.toolName), ['list_workflows','run_workflow']);
    assert.equal(result.toolCalls.at(-1).result.execution.missingInputs[0].key, 'exportFile');
  });
});
test('a failed workflow falls back to the data loop and is never retried in the same request', async t => {
  const governance = require('../src/backend/governance/context'), automation = require('../src/backend/automation');
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const manager = require('../src/backend/agent_core').defaultToolManager, d = report();
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [d]);
  t.mock.method(automation.registry, 'getTemplate', async () => d);
  t.mock.method(automation.runtime, 'pending', async () => null);
  let runs = 0;
  t.mock.method(automation.runtime, 'create', async () => { runs++; return { id: 'failed-run', status: 'FAILED', name: d.name, error: { message: 'source timeout' } }; });
  const call = (name, args) => ({ tool_calls: [{ id: `${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  let agentRounds = 0;
  const harness = new Harness({ toolManager: manager, dispatch: async (provider, messages, definitions) => {
    const name = definitions[0]?.function.name;
    if (name === 'choose_workflow') return call(name, { templateId: d.id, inputs: { months: 7, drawChart: true }, evidence: { months: '7', drawChart: 'vẽ biểu đồ' } });
    if (name === 'assess_workflow') return call(name, { suitable: true, reason: 'Exact report', confirmedSlots: ['months', 'drawChart'] });
    agentRounds++;
    return agentRounds === 1 ? call('list_workflows', {}) : agentRounds === 2 ? call('run_workflow', { templateId: d.id, inputs: { months: 7, drawChart: true } })
      : { content: 'Chưa lấy được dữ liệu.' };
  } });
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:fallback-owner', role: 'admin' });
    const result = await harness.run({ userMessage: 'vẽ biểu đồ trong 7 tháng', provider: { id: 'test', supportsToolCalling: true },
      enabledToolNames: ['list_workflows', 'run_workflow', 'search_schema', 'execute_sql_query'],
      context: { governedController: true, lockProvider: true, permissions: ['admin'], session: { id: 'fallback-test', accountId: 'fallback-owner' },
        requestPlan: { outputs: { data: true, chart: true } }, mode: 'data' } });
    assert.equal(runs, 1);
    assert.ok(result.trace.steps.some(step => step.type === 'WORKFLOW_FAILED_FALLBACK'));
    assert.ok(!result.trace.steps.some(step => step.type === 'WORKFLOW_TOOL_HANDOFF'));
    assert.ok(result.toolCalls.some(item => item.toolName === 'run_workflow' && item.code === 'WORKFLOW_ALREADY_REJECTED'));
    assert.notEqual(result.replyText, 'Quy trình chưa thể hoàn tất.');
  });
});
