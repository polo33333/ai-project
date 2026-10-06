'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryService } = require('../src/backend/memory_core');
const bridge = require('../src/backend/automation/conversation_memory');
const automation = require('../src/backend/automation');
const tools = require('../src/backend/intelligent_core/tool_registry');
const { GetWorkflowDatasetTool, ExportDataTool } = require('../src/backend/agent_core/tools/builtins');
const { resolvePlan } = require('../src/backend/agent_core/harness/completion_policy');
const { getRequestPolicy } = require('../src/backend/agent_core/harness/local_execution_policy');

function fixture() {
  const rows = Array.from({ length: 121 }, (_, i) => ({ code: `item-${i}`, total: i }));
  const run = { id: 'run-memory', ownerId: 'owner', conversationId: 'conversation', status: 'SUCCEEDED',
    templateId: 'reports/monthly', updatedAt: new Date().toISOString(), input: {},
    definition: { bindings: { query: { dbSourceId: 'db-one', tables: ['dbo.Report'] } } } };
  const view = { name: 'Monthly report', inputs: { months: 3 }, result: { rows }, artifacts: [] };
  const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
  return { run, view, rows, memory };
}

test('completed result stores bounded references, survives reload, and routes chart/export follow-ups', () => {
  const { run, view, memory } = fixture();
  assert.equal(bridge.persist({ ...run, status: 'WAITING_INPUT' }, view, memory).persisted, false);
  assert.equal(memory.getSession('conversation', false, 'owner'), null);
  assert.equal(bridge.persist(run, view, memory).persisted, true);
  const reloaded = new MemoryService({ store: structuredClone(memory.store), save: () => {} });
  const session = reloaded.getSession('conversation', false, 'owner');
  assert.equal(session.references.lastDataset.rowCount, 121);
  assert.equal(session.references.lastDataset.preview.length, 5);
  assert.equal(session.lastWorkflowRun.runId, run.id);
  for (const question of ['vẽ biểu đồ dữ liệu đó', 'xuất kết quả vừa rồi']) {
    const decision = reloaded.route({ sessionId: 'conversation', accountId: 'owner', question, currentPlan: {} });
    assert.equal(decision.mode, 'reference');
    assert.equal(decision.reference.data.runId, run.id);
    assert.match(reloaded.getContext(decision)[0].content, /item-0/);
  }
  assert.equal(bridge.persist(run, view, reloaded).reason, 'already_recorded');
  assert.equal(session.messages.length, 2);
  assert.equal(reloaded.getSession('conversation', false, 'another-owner'), null);
});

test('multiple datasets remain explicit and a new result clears stale entity/file references', () => {
  const { run, view, memory } = fixture();
  bridge.persist(run, { ...view, result: { rows: [view.result.rows[0]] }, artifacts: [{ downloadUrl: '/old' }] }, memory);
  bridge.persist({ ...run, id: 'run-next' }, { ...view, result: { rows: view.result.rows, other: [] } }, memory);
  const session = memory.getSession('conversation', false, 'owner');
  assert.equal(session.references.lastEntity, null);
  assert.equal(session.references.lastExport, null);
  assert.equal(session.references.lastDataset.datasets.length, 2);
});

test('a single workflow entity and its dataset resolve the same antecedent without ambiguity', () => {
  const { run, view, memory } = fixture();
  bridge.persist(run, { ...view, result: { employees: [{ EmployeeCode: 'NV007', GenderID: 'Nam' }] } }, memory);
  for (const question of ['nhân viên trên có giới tính là gì', 'giới tính nv trên là gì']) {
    const decision = memory.route({ sessionId: 'conversation', accountId: 'owner', question, currentPlan: {} });
    assert.equal(decision.mode, 'reference');
    assert.equal(decision.reference.type, 'lastEntity');
    assert.equal(decision.reference.data.filters.GenderID, 'Nam');
  }
});

test('a new SQL list replaces the older workflow entity instead of answering from stale data', () => {
  const { run, view, memory } = fixture();
  bridge.persist(run, view, memory);
  memory.persistSuccessfulExchange({ sessionId: 'conversation', accountId: 'owner', question: 'ds hđ', reply: 'Contracts HD001 and HD002',
    currentPlan: { table: 'T_Contract', intent: 'list', identityColumns: ['ContractNo'] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ ContractNo: 'HD001' }, { ContractNo: 'HD002' }] } }],
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
  const session = memory.getSession('conversation', false, 'owner');
  assert.equal(session.lastWorkflowRun, null);
  assert.equal(session.references.lastEntity, null);
  assert.equal(session.references.lastDataset.table, 'T_Contract');
  assert.deepEqual(session.references.lastDataset.entityKeys, [{ ContractNo: 'HD001' }, { ContractNo: 'HD002' }]);
});

test('dataset access checks account, conversation, current permissions, expiry and field ambiguity', async () => {
  const { run, view, rows } = fixture();
  let allowed = true;
  const fake = { runtime: { owned: async (_id, context) => {
    if (context.accountId !== run.ownerId) throw new Error('not owned');
    return run;
  }, view: () => view }, registry: { canContinue: async () => allowed } };
  const context = { session: { id: 'conversation', accountId: 'owner' }, permissions: ['sql:read'] };
  assert.deepEqual((await bridge.readDataset({ runId: run.id }, context, fake)).rows, rows);
  await assert.rejects(bridge.readDataset({ runId: run.id }, { session: { id: 'other', accountId: 'owner' } }, fake), /conversation/);
  await assert.rejects(bridge.readDataset({ runId: run.id }, { session: { id: 'conversation', accountId: 'other' } }, fake), /not owned/);
  allowed = false;
  await assert.rejects(bridge.readDataset({ runId: run.id }, context, fake), /revoked/);
  allowed = true; run.updatedAt = '2000-01-01T00:00:00Z';
  await assert.rejects(bridge.readDataset({ runId: run.id }, context, fake), /expired/);
  run.updatedAt = new Date().toISOString(); view.result.other = [];
  await assert.rejects(bridge.readDataset({ runId: run.id }, context, fake), /field/);
});

test('both tool paths paginate reads and export all verified rows instead of previews', async t => {
  const { run, view } = fixture();
  const original = { owned: automation.runtime.owned, view: automation.runtime.view, canContinue: automation.registry.canContinue };
  t.after(() => { Object.assign(automation.runtime, { owned: original.owned, view: original.view }); automation.registry.canContinue = original.canContinue; });
  automation.runtime.owned = async () => run;
  automation.runtime.view = () => view;
  automation.registry.canContinue = async () => true;
  const context = { session: { id: 'conversation', accountId: 'owner' } };
  for (const execute of [args => tools.executeTool('get_workflow_dataset', args, context), args => new GetWorkflowDatasetTool().execute(args, context)]) {
    const result = await execute({ runId: run.id, field: 'rows', offset: 100, limit: 100 });
    assert.equal(result.success, true);
    assert.equal(result.result.rows.length, 21);
    assert.equal(result.result.rowCount, 121);
    assert.equal(result.result.hasMore, false);
  }
  for (const execute of [args => tools.executeTool('export_data', args, context), args => new ExportDataTool().execute(args, context)]) {
    const result = await execute({ workflowRunId: run.id, workflowField: 'rows', data: view.result.rows.slice(0, 5), format: 'csv' });
    assert.equal(result.success, true, result.error);
    const filename = path.join(require('../src/backend/utils/export_paths').getExportsDirectory(), path.basename(result.result.downloadUrl));
    t.after(() => fs.unlinkSync(filename));
    assert.match(fs.readFileSync(filename, 'utf8'), /item-120/);
  }
  const { RenderChartTool } = require('../src/backend/agent_core/tools/builtins');
  const chartContext = { ...context, workflowRunId: run.id };
  const chart = { type: 'bar', labels: ['item-1'], datasets: [{ label: 'total', data: [999] }] };
  for (const execute of [args => tools.executeTool('render_chart', args, chartContext), args => new RenderChartTool().execute(args, chartContext)]) {
    assert.equal((await execute(chart)).success, false);
    assert.equal((await execute({ ...chart, datasets: [{ label: 'total', data: [1] }] })).success, true);
  }
});

test('workflow follow-ups require real output tools without requiring a new SQL query', () => {
  const plan = resolvePlan('export', { workflowReference: true, outputs: { data: false, chart: true, export: true } }, { mode: 'general' });
  const policy = getRequestPolicy(plan, { mode: 'general' });
  assert.equal(policy.dataRequired, false);
  assert.equal(policy.chartRequired, true);
  assert.equal(policy.exportRequired, true);
});

test('worker records a form-completed run once and memory survives a service restart', async t => {
  const { AutomationRepository } = require('../src/backend/automation/repository');
  const { PluginRegistry } = require('../src/backend/automation/registry');
  const { AutomationRuntime } = require('../src/backend/automation/runtime');
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'workflow-memory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new AutomationRepository({ directory });
  const registry = new PluginRegistry(repository);
  const context = { accountId: 'form-owner', permissions: ['admin'] };
  const runtime = new AutomationRuntime(repository, registry, { enabled: () => true, authorizeContext: async () => context });
  const bundle = structuredClone(require('../src/backend/automation/pilot.json'));
  bundle.manifest.id = 'memory_forms'; bundle.templates = [bundle.templates[0]];
  let record = await registry.import(bundle, context);
  assert.equal((await registry.test(record.id, context)).passed, true);
  record = await repository.get('catalog', record.id);
  await registry.publish(record.id, context, record.revision);
  const memory = require('../src/backend/memory_core').memoryService;
  const sessionId = 'form-memory-session';
  const started = await runtime.create('memory_forms/lookup', {}, context, { conversationId: sessionId });
  assert.equal(started.status, 'WAITING_INPUT');
  assert.equal(memory.getSession(sessionId, false, context.accountId), null);
  await runtime.inputs(started.id, { code: 'ABC-123' }, context, started.revision);
  await runtime.process(started.id);
  const saved = memory.getSession(sessionId, false, context.accountId);
  assert.equal(saved.lastWorkflowRun.status, 'SUCCEEDED');
  assert.equal(saved.lastWorkflowRun.inputs.code, 'ABC-123');
  assert.equal(saved.references.lastEntity.filters.code, 'ABC-123');
  await runtime.process(started.id);
  assert.equal(saved.messages.length, 2);
  const restarted = new MemoryService();
  assert.equal(restarted.getSession(sessionId, false, context.accountId).lastWorkflowRun.runId, started.id);
});
