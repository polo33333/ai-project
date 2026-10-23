'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const resolver = require('../src/backend/memory_core/conversation_resolver');
const suitability = require('../src/backend/memory_core/workflow_suitability');
const semantic = require('../src/backend/memory_core/semantic_recall');
const candidates = [{ id: 'e1', kind: 'entity', data: { key: { EmployeeCode: 'NV004' } } },
  { id: 'e2', kind: 'entity', data: { key: { EmployeeCode: 'NV007' } } },
  { id: 'p1', kind: 'preference', data: { content: 'Vietnamese' } }];
function result(patch = {}) { return { relation: 'followup', operation: 'attribute', cardinality: 'single',
  attributes: ['address'], selectedIds: ['e1'], clarification: '', dataUse: 'none', ...patch }; }
const response = value => ({ content: JSON.stringify(value) });

test('a pending time-window task resolves collection parameters but never proves a single entity or historical dataset', () => {
  const tasks = [{ id: 'task:temporal-horizon', kind: 'task', data: { clarification: 'temporal_horizon', question: 'Which records expire soon?' } }];
  const selection = result({ operation: 'list', cardinality: 'collection', attributes: [], selectedIds: ['task:temporal-horizon'], dataUse: 'current' });
  assert.equal(resolver.decode(response(selection), tasks).selected[0].kind, 'task');
  for (const patch of [{ operation: 'attribute', cardinality: 'single' }, { dataUse: 'historical' }]) {
    assert.throws(() => resolver.decode(response({ ...selection, ...patch }), tasks), /MEMORY_RESOLUTION_MISSING_REFERENCE/);
  }
});
test('resolver reconstructs only verified entity IDs and keeps requested attributes', () => {
  const value = resolver.decode(response(result()), candidates);
  assert.equal(value.selected[0], candidates[0]); assert.deepEqual(value.attributes, ['address']);
});

test('entity lookups cannot downgrade freshness through resolver dataUse', () => {
  for (const operation of ['list', 'detail', 'attribute', 'compare']) {
    for (const dataUse of ['none', 'historical']) {
      assert.equal(resolver.decode(response(result({ operation, dataUse })), candidates).dataUse, 'current');
    }
  }
});

test('historical dataset comparison remains historical without inheriting unrelated entities', () => {
  const dataset = { id: 'd1', kind: 'dataset', data: { runId: 'past-run' } };
  const value = resolver.decode(response(result({ operation: 'compare', dataUse: 'historical',
    cardinality: 'collection', selectedIds: ['d1'] })), [...candidates, dataset]);
  assert.equal(value.dataUse, 'historical');
  assert.deepEqual(value.selectedIds, ['d1']);
});

test('a singular entity attribute cannot silently choose a row from a multi-row dataset', () => {
  const dataset = { id: 'd1', kind: 'dataset', data: { rowCount: 9 } };
  assert.throws(() => resolver.decode(response(result({ selectedIds: ['d1'], dataUse: 'historical' })), [dataset]), /AMBIGUOUS/);
  const ambiguous = resolver.decode(response(result({ relation: 'ambiguous', selectedIds: ['d1'], clarification: 'Which record?' })), [dataset]);
  assert.equal(ambiguous.relation, 'ambiguous');
});
test('resolver rejects invented IDs, multiple singular entities and unexpected schema fields', () => {
  assert.throws(() => resolver.decode(response(result({ selectedIds: ['fake'] })), candidates), /UNKNOWN_ID/);
  assert.throws(() => resolver.decode(response(result({ selectedIds: ['e1', 'e2'] })), candidates), /AMBIGUOUS/);
  assert.throws(() => resolver.decode(response(result({ sql: 'SELECT 1' })), candidates), /SCHEMA_INVALID/);
});
test('independent collection cannot inherit an entity; relevant preference is allowed', () => {
  assert.deepEqual(resolver.decode(response(result({ relation: 'independent', operation: 'list', cardinality: 'collection' })), candidates).selected, []);
  assert.equal(resolver.decode(response(result({ relation: 'independent', selectedIds: ['p1'] })), candidates).selected.length, 1);
});
test('explicit independent detail and comparison do not fail when their codes also exist in memory', () => {
  const detail = resolver.decode(response(result({ relation: 'independent', operation: 'detail', selectedIds: ['e2'],
    attributes: Array.from({ length: 11 }, (_, i) => `field${i}`) })), candidates);
  assert.deepEqual(detail.selectedIds, []);
  const compare = resolver.decode(response(result({ relation: 'independent', operation: 'compare', cardinality: 'collection',
    selectedIds: ['e1', 'e2'], presentation: 'table' })), candidates);
  assert.equal(compare.operation, 'compare'); assert.equal(compare.presentation, 'table'); assert.deepEqual(compare.selected, []);
});
test('forecast resolves a dataset even when there are unrelated employee candidates', () => {
  const dataset = { id: 'dataset:latest', kind: 'dataset', data: { runId: 'run-sales', field: 'rows', rowCount: 2 } };
  const value = resolver.decode(response(result({ operation: 'forecast', cardinality: 'collection', selectedIds: [dataset.id] })), [...candidates, dataset]);
  assert.equal(value.selected[0], dataset);
});
test('malformed resolver output gets at most one schema repair with validation details', async () => {
  let calls = 0, rejected = 0;
  const value = await resolver.resolve(async (defs, messages, stage) => {
    calls++;
    if (calls === 1) return response(result({ operation: 'unsupported' }));
    assert.equal(stage, 'memory_resolution_repair'); assert.ok(messages.at(-1).content.includes('validationErrors'));
    return response(result({ operation: 'forecast' }));
  }, 'forecast the data above', { candidates }, () => rejected++);
  assert.equal(calls, 2); assert.equal(rejected, 1); assert.equal(value.operation, 'forecast');
});
test('ambiguous references require clarification instead of executing a guessed entity', () => {
  assert.throws(() => resolver.decode(response(result({ relation: 'ambiguous' })), candidates), /CLARIFICATION/);
  assert.equal(resolver.decode(response(result({ relation: 'ambiguous', selectedIds: [], clarification: 'Which employee?' })), candidates).relation, 'ambiguous');
});
test('workflow assessment rejects list-to-detail mismatch and malformed model output', async () => {
  await assert.rejects(suitability.assess(async () => response({ suitable: false, reason: 'Single-record lookup does not return the requested list.' }), 'list employees', null, {}), { code: 'WORKFLOW_OPERATION_MISMATCH' });
  await assert.rejects(suitability.assess(async () => response({ suitable: 'true' }), 'list', null, {}), { code: 'WORKFLOW_ASSESSMENT_INVALID' });
});
test('workflow assessment accepts matching output and receives only definition contract', async () => {
  const value = await suitability.assess(async (defs, messages, stage) => {
    assert.equal(stage, 'workflow_suitability'); assert.ok(!messages[1].content.includes('secretBinding'));
    return response({ suitable: true, reason: 'Matches requested collection.' });
  }, 'list', null, { name: 'List', bindings: { secretBinding: 'secret' } });
  assert.equal(value.suitable, true);
});
function fakeMemory() {
  const items = [{ id: 'a', revision: 1, owner: 'a', question: 'old electricity report' },
    { id: 'b', revision: 1, owner: 'a', question: 'employee detail' }];
  return { items, list(args) { return { items: args.query ? items.slice(0, 1) : items, total: items.length }; },
    actor() { return {}; }, visible() { return true; }, resourcesAllowed() { return true; } };
}
test('embedding disabled never invokes model and preserves lexical retrieval', async () => {
  const value = await semantic.recall(fakeMemory(), { query: 'staff' }, { enabled: () => false,
    service: { embedTexts() { throw new Error('must not call'); } } });
  assert.equal(value.retrievalMode, 'lexical');
});
test('semantic event retrieval ranks authorized events by meaning', async () => {
  const value = await semantic.recall(fakeMemory(), { query: 'staff', limit: 5 }, { enabled: () => true, refresh: async () => {},
    service: { embeddingModel: 'fixture-ranking', embedTexts: async () => [[0, 1], [1, 0], [0, 1]] } });
  assert.equal(value.retrievalMode, 'semantic'); assert.equal(value.items[0].id, 'b');
});
test('embedding outage falls back to fresh lexical permissions', async () => {
  const memory = fakeMemory();
  const value = await semantic.recall(memory, { query: 'staff' }, { enabled: () => true,
    service: { embedTexts: async () => { memory.items.splice(0); throw new Error('offline'); } } });
  assert.equal(value.retrievalMode, 'lexical'); assert.deepEqual(value.items, []);
});
test('revoked events after embedding are never returned', async () => {
  const memory = fakeMemory();
  const value = await semantic.recall(memory, { query: 'staff' }, { enabled: () => true,
    refresh: async () => { memory.items.splice(0); },
    service: { embeddingModel: 'fixture-revoke', embedTexts: async () => [[0, 1], [1, 0], [0, 1]] } });
  assert.deepEqual(value.items, []);
});

test('shared harness selects permitted memory but cannot claim an unqueried address from it', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  let calls = 0;
  const harness = new Harness({ toolManager: { getToolDefinitions: () => [] }, dispatch: async (provider, messages, defs) => {
    calls++;
    if (defs[0]?.function.name === 'resolve_conversation') {
      assert.ok(messages[1].content.includes('NV007'));
      return { ...response(result({ presentation: 'table' })), usage: { inputTokens: 10, outputTokens: 5 } };
    }
    assert.ok(messages[0].content.includes('NV004')); assert.ok(!messages[0].content.includes('NV007'));
    return { content: 'The permitted schema does not expose this address.', usage: { inputTokens: 20, outputTokens: 6 } };
  } });
  const value = await harness.run({ userMessage: 'address of the employee above', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'general',
      requestPlan: { outputs: { data: false } }, resolutionContext: { candidates, recent: [] } } });
  assert.equal(calls, 4); assert.equal(value.tokenUsage.inputTokens, 70);
  assert.equal(value.trace.completionStatus, 'PARTIAL');
  assert.equal(value.trace.executionBudget.repairAttempts, 2);
  assert.equal(value.trace.training.plan.presentation, 'table');
  assert.equal(value.trace.steps.find(step => step.type === 'MODEL_USAGE').stage, 'memory_resolution');
});
test('ambiguous resolver stops shared harness before any business tool or second model call', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  let calls = 0;
  const harness = new Harness({ toolManager: { getToolDefinitions: () => [] }, dispatch: async () => {
    calls++; return response(result({ relation: 'ambiguous', selectedIds: [], clarification: 'Which employee code?' }));
  } });
  const value = await harness.run({ userMessage: 'the employee above', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'general', requestPlan: { outputs: { data: false } },
      resolutionContext: { candidates, recent: [] } } });
  assert.equal(calls, 1); assert.equal(value.replyText, 'Which employee code?'); assert.deepEqual(value.toolCalls, []);
});
test('resolver failure does not block a self-contained current request or reuse stale memory', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  let calls = 0;
  const memoryDecision = { mode: 'reference', reference: { data: { runId: 'stale-run' } } };
  const harness = new Harness({ toolManager: { getToolDefinitions: () => [] }, dispatch: async (provider, messages, defs) => {
    calls++;
    if (defs[0]?.function.name === 'resolve_conversation') return response(result({ selectedIds: ['not-authorized'] }));
    assert.ok(!messages[0].content.includes('NV004'));
    return { content: 'A self-contained answer from the current request.' };
  } });
  const value = await harness.run({ userMessage: 'explain a self-contained topic', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'general', memoryDecision,
      requestPlan: { outputs: { data: false } }, resolutionContext: { candidates, recent: [] } } });
  assert.equal(calls, 3); assert.equal(value.replyText, 'A self-contained answer from the current request.');
  assert.equal(memoryDecision.reference, undefined); assert.equal(memoryDecision.resolverStatus, 'unavailable');
  const diagnostics = require('../src/backend/utils/chat_diagnostics').buildChatDiagnostics(value.trace);
  assert.equal(diagnostics.steps.find(step => step.type === 'MEMORY_RESOLUTION_REJECTED').code, 'MEMORY_RESOLUTION_UNKNOWN_ID');
});
test('current entity lookup cannot pass completion using memory alone', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const harness = new Harness({ maxIterations: 1, maxRepairs: 0, toolManager: { getToolDefinitions: () => [] },
    dispatch: async (provider, messages, defs) => defs[0]?.function.name === 'resolve_conversation'
      ? response(result({ operation: 'detail', dataUse: 'current' })) : { content: 'An employee profile copied from memory.' } });
  const value = await harness.run({ userMessage: 'employee detail', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'general', requestPlan: { outputs: { data: false } },
      resolutionContext: { candidates, recent: [] } } });
  assert.equal(value.trace.training.plan.outputs.data, true);
  assert.equal(value.trace.training.responseEvaluation.valid, false);
  assert.ok(value.trace.training.responseEvaluation.failures.includes('MISSING_SQL'));
});

test('structured session retains multiple verified identities and excludes expired references', () => {
  const { MemoryService } = require('../src/backend/memory_core/memory_service');
  const service = new MemoryService({ store: { sessions: {} }, save() {} });
  const session = service.getSession('resolve-session', true, 'owner');
  for (const code of ['NV004', 'NV007']) {
    session.references.lastDataset = { table: 'Employees', entityKeys: [{ EmployeeCode: code }], updatedAt: new Date().toISOString() };
    service.captureEntities(session);
  }
  session.conversationState = { operation: 'attribute', requestedAttributes: ['address'], references: [{ secret: 'not part of request metadata' }] };
  let state = service.getResolutionContext({ sessionId: 'resolve-session', accountId: 'owner' });
  assert.equal(state.candidates.filter(item => item.kind === 'entity').length, 2); assert.deepEqual(state.previousRequest.requestedAttributes, ['address']);
  assert.equal(state.previousRequest.references, undefined);
  session.entityReferences[0].updatedAt = '2000-01-01T00:00:00.000Z';
  state = service.getResolutionContext({ sessionId: 'resolve-session', accountId: 'owner' });
  assert.equal(state.candidates.filter(item => item.kind === 'entity').length, 1); assert.equal(state.candidates[0].data.key.EmployeeCode, 'NV007');
});

test('workflow gateway does not create a run when assessment rejects the operation', async t => {
  const governance = require('../src/backend/governance/context');
  await governance.run(async () => {
    governance.setPrincipal({ subject: 'account:owner', role: 'user', channel: 'chat' });
    const automation = require('../src/backend/automation');
    t.mock.method(automation, 'settings', async () => ({ enabled: true }));
    t.mock.method(automation.registry, 'getTemplate', async () => ({ name: 'Detail', bindings: {} }));
    const create = t.mock.method(automation.runtime, 'create', async () => { throw new Error('Must not create a run'); });
    await assert.rejects(require('../src/backend/governance/workflow_tools').execute('run_workflow', { templateId: 'detail' }, {
      session: { id: 'session', accountId: 'owner' }, permissions: [], governedController: true,
      assessWorkflow: async () => { throw Object.assign(new Error('List request cannot use detail'), { code: 'WORKFLOW_OPERATION_MISMATCH' }); }
    }), { code: 'WORKFLOW_OPERATION_MISMATCH' });
    assert.equal(create.mock.callCount(), 0);
  });
});
