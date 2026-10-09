'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/backend/automation/chat_router');
const adapters = require('../src/backend/intelligent_core/adapters');
const providers = require('../src/backend/services/ai_provider_manager');
const automation = require('../src/backend/automation');
const orchestrator = require('../src/backend/automation/orchestrator');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
const retrieval = require('../src/backend/automation/workflow_retrieval');

const chatProvider = { id: 'chosen', name: 'Chosen chat', model: 'chosen-chat', type: 'openai', apiFormat: 'openai',
  executionClass: 'remote', baseUrl: 'https://chosen.invalid/v1', apiKey: 'test-secret', contextWindow: 32768 };
const definition = { id: 'contracts/detail', name: 'Tra cứu hợp đồng', description: 'Tra cứu chi tiết hợp đồng theo mã',
  inputs: { code: { required: true, ask: 'Mã hợp đồng?', schema: { type: 'string', minLength: 1 } } } };
const other = { id: 'employees/detail', name: 'Tra cứu nhân viên', description: 'Tra cứu nhân viên theo mã', inputs: definition.inputs };
function decision(overrides = {}) {
  return { route: 'chat', purpose: overrides.route === 'workflow' ? 'execute' : overrides.route === 'unclear' ? 'unclear' : 'none', workflowId: null, candidateIds: [], inputDisposition: 'none', pendingRunId: null,
    inputs: {}, inputEvidence: {}, evidence: [], requestedScope: 'unclear', supportedScope: 'unclear',
    needsClarification: false, abstain: false, cancelPending: false, ...overrides };
}
function workflow(question, overrides = {}) {
  return decision({ route: 'workflow', workflowId: definition.id, inputDisposition: 'new_request',
    evidence: [{ source: 'user_message', text: question }], requestedScope: 'targeted', supportedScope: 'targeted', ...overrides });
}
test('new workflow request clears only an echoed known pending ID without authorizing an update', () => {
  const current = { id: 'known-pending', templateId: other.id, status: 'WAITING_INPUT' };
  const result = router.validateDecision(workflow('Tra cứu hợp đồng', { pendingRunId: current.id }), 'Tra cứu hợp đồng', [definition, other], current);
  assert.equal(result.route, 'workflow');
  assert.equal(result.pendingRunId, null);
  assert.equal(result.inputDisposition, 'new_request');
  assert.throws(() => router.validateDecision(workflow('Tra cứu hợp đồng', { pendingRunId: 'unknown' }), 'Tra cứu hợp đồng', [definition, other], current), { code: 'ROUTING_INVALID_OUTPUT' });
});
function fixture(t, mode = 'local_tev1', extraEnv = {}) {
  const env = { CHAT_ROUTING_MODE: mode, CHAT_ROUTING_LOCAL_MODEL: 'tev1:4b', CHAT_ROUTING_TIMEOUT_MS: '10000',
    CHAT_QUICK_GREETING_ENABLED: 'false',
    CHAT_ROUTING_LOCAL_BASE_URL: 'http://127.0.0.1:11434', ...extraEnv };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  t.mock.method(providers, 'getProvidersForExecution', () => []);
  return router.createRoutingContext({ chatProviderSnapshot: chatProvider, requestId: 'request-fixture' });
}
function response(value, provider) {
  if (!provider?.decisionTask) return { content: JSON.stringify(value), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1 } };
  const task = provider.decisionTask;
  const answers = {};
  for (const [key, query] of Object.entries(task.questions)) {
    let pick;
    if (key === 'route') pick = value.cancelPending ? 'cancel' : value.inputDisposition === 'slot_answer' ? 'slot_answer'
      : value.route === 'workflow' || value.purpose === 'explain' ? value.workflowId === definition.id ? 'w0' : value.workflowId === other.id ? 'w1' : 'unauthorized'
        : value.abstain ? 'unclear' : value.route;
    else if (key === 'purpose') pick = value.purpose;
    else if (key === 'requested_scope') pick = value.requestedScope;
    else if (key.startsWith('scope_')) pick = value.route === 'workflow' ? value.supportedScope : 'targeted';
    else if (key === 'pending_turn') pick = value.cancelPending ? 'cancel' : value.inputDisposition === 'slot_answer' ? 'slot_answer' : value.route === 'workflow' ? 'new_request' : 'unrelated';
    else if (key.startsWith('input_')) pick = Object.entries(query.criteria).find(([, text]) => text === JSON.stringify(value.inputs.code))?.[0] || 'none';
    else if (key.startsWith('provided_')) pick = Object.keys(value.inputs).length ? 'yes' : 'no';
    const options = Object.keys(query.criteria);
    answers[key] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(options.map(option => [option, option === pick ? 0.96 : 0.04 / (options.length - 1)])), confidence: 0.9 };
  }
  return { content: JSON.stringify({ answers }), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: Object.keys(task.questions).length } };
}

test('retrieval passes only the authorized shortlist to TEV1 from a large catalog', async t => {
  const context = fixture(t, 'auto', { CHAT_ROUTING_RETRIEVAL_MODE: 'on' });
  const catalog = [definition, other, ...Array.from({ length: 98 }, (_, i) => ({ ...other, id: `extra/${i}` }))];
  t.mock.method(retrieval.service, 'search', async (_, allowed) => {
    assert.equal(allowed.length, 100);
    return { definitions: [definition], trace: { catalogCount: 100, candidateCount: 1 } };
  });
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    assert.equal(JSON.parse(messages[1].content).catalog.length, 1);
    assert.ok(provider.decisionTask);
    return response(workflow('Tra cứu hợp đồng'), provider);
  });
  const result = await router.decide('Tra cứu hợp đồng', catalog, null, { routingContext: context });
  assert.equal(result.workflowId, definition.id);
  assert.equal(context.trace.retrieval.candidateCount, 1);
});
test('uncertain shortlist escalates once against the full authorized catalog', async t => {
  const context = fixture(t, 'auto', { CHAT_ROUTING_RETRIEVAL_MODE: 'on' });
  t.mock.method(retrieval.service, 'search', async () => ({ definitions: [definition], trace: {} }));
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    calls.push(JSON.parse(messages[1].content).catalog.length);
    return response(provider.decisionTask ? decision({ route: 'unclear', needsClarification: true }) : decision(), provider);
  });
  await router.decide('yêu cầu chưa rõ', [definition, other], null, { routingContext: context });
  assert.deepEqual(calls, [1, 2]);
});
test('retrieval outage uses one chat escalation even if that model returns unclear', async t => {
  const context = fixture(t, 'auto', { CHAT_ROUTING_RETRIEVAL_MODE: 'on' });
  t.mock.method(retrieval.service, 'search', async () => { throw Object.assign(new Error('unavailable'), { code: 'ROUTING_RETRIEVAL_UNAVAILABLE' }); });
  const mock = t.mock.method(adapters, 'dispatchToProvider', async provider => {
    assert.equal(provider.model, chatProvider.model);
    return response(decision({ route: 'unclear', needsClarification: true }), provider);
  });
  const result = await router.decide('Tra cứu hợp đồng', [definition, other], null, { routingContext: context });
  assert.equal(result.route, 'unclear'); assert.equal(mock.mock.callCount(), 1);
});
test('local_tev1 retrieval outage never invokes model chat', async t => {
  const context = fixture(t, 'local_tev1', { CHAT_ROUTING_RETRIEVAL_MODE: 'on' });
  t.mock.method(retrieval.service, 'search', async () => { throw new Error('unavailable'); });
  const mock = t.mock.method(adapters, 'dispatchToProvider', async () => { throw new Error('unexpected call'); });
  await assert.rejects(router.decide('Tra cứu hợp đồng', [definition], null, { routingContext: context }), { code: 'ROUTING_RETRIEVAL_UNAVAILABLE' });
  assert.equal(mock.mock.callCount(), 0);
});
test('chat failure after retrieval outage is propagated without a second escalation', async t => {
  const context = fixture(t, 'auto', { CHAT_ROUTING_RETRIEVAL_MODE: 'on' });
  t.mock.method(retrieval.service, 'search', async () => { throw new Error('unavailable'); });
  const mock = t.mock.method(adapters, 'dispatchToProvider', async () => { throw new Error('chat unavailable'); });
  await assert.rejects(router.decide('Tra cứu hợp đồng', [definition], null, { routingContext: context }), { code: 'ROUTING_PROVIDER_ERROR' });
  assert.equal(mock.mock.callCount(), 1);
});
test('shadow retrieval does not change the catalog sent to the router', async t => {
  const context = fixture(t, 'local_tev1', { CHAT_ROUTING_RETRIEVAL_MODE: 'shadow' });
  t.mock.method(retrieval.service, 'search', async () => ({ definitions: [definition], trace: {} }));
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    assert.equal(JSON.parse(messages[1].content).catalog.length, 2);
    return response(decision(), provider);
  });
  await router.decide('giải thích', [definition, other], null, { routingContext: context });
});

for (const mode of router.MODES) {
  test(`${mode}: pins routing and chat providers and records one decision`, async t => {
    const context = fixture(t, mode);
    const calls = [], usages = [];
    t.mock.method(adapters, 'dispatchToProvider', async (provider, messages, tools) => {
      calls.push(provider); assert.deepEqual(tools, []);
      const payload = JSON.parse(messages[1].content);
      assert.equal(payload.catalog.length, 2);
      return response(decision(), provider);
    });
    const result = await router.decide('Xin chào', [definition, other], null, { routingContext: context, onWorkflowUsage: usage => usages.push(usage) });
    await router.decide('Xin chào', [definition, other], null, { routingContext: context });
    assert.equal(result.route, 'chat');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, mode === 'chat_model' ? chatProvider.model : 'tev1:4b');
    assert.equal(context.chatProviderSnapshot.model, chatProvider.model);
    assert.equal(context.executionBudget.modelCalls, mode === 'chat_model' ? 1 : 7);
    assert.equal(usages.length, 1);
    assert.equal(context.trace.decisionSource, mode === 'chat_model' ? 'chat_model' : 'local_tev1');
    assert.equal(context.trace.chatModel, chatProvider.model);
    assert.ok(!JSON.stringify(context.trace).includes('test-secret'));
    assert.equal(context.trace.escalated, false);
  });
}

test('local_tev1 selects a workflow with missing inputs in one call', async t => {
  const context = fixture(t);
  const mock = t.mock.method(adapters, 'dispatchToProvider', async provider => response(workflow('Tra cứu hợp đồng'), provider));
  const result = await router.decide('Tra cứu hợp đồng', [definition], null, { routingContext: context });
  assert.equal(result.workflowId, definition.id);
  assert.deepEqual(result.inputs, {});
  assert.equal(mock.mock.callCount(), 1);
});

test('chat model empty lookup placeholder is missing input, not a routing failure', () => {
  const output = router.validateDecision(workflow('thông tin chi tiết nv', {
    inputs: { code: '' }, inputEvidence: { code: 'thông tin chi tiết nv' }
  }), 'thông tin chi tiết nv', [definition], null);
  assert.equal(output.route, 'workflow');
  assert.deepEqual(output.inputs, {});
  assert.deepEqual(output.inputEvidence, {});
});

for (const failure of ['unclear', 'abstain', 'invalid_json', 'unknown_id', 'provider_error', 'scope_conflict']) {
  test(`auto escalates once on ${failure} to the pinned chat model`, async t => {
    const context = fixture(t, 'auto');
    const called = [];
    t.mock.method(adapters, 'dispatchToProvider', async provider => {
      called.push(provider.model);
      if (called.length === 2) return response(workflow('Tra cứu hợp đồng'), provider);
      if (failure === 'provider_error') throw new Error('secret upstream detail');
      if (failure === 'invalid_json') return { content: 'bad json' };
      if (failure === 'unknown_id') return response(workflow('Tra cứu hợp đồng', { workflowId: 'unauthorized' }), provider);
      if (failure === 'scope_conflict') return response(workflow('Tra cứu hợp đồng', { requestedScope: 'collection' }), provider);
      return response(decision({ route: failure === 'unclear' ? 'unclear' : 'chat', abstain: failure === 'abstain' }), provider);
    });
    const result = await router.decide('Tra cứu hợp đồng', [definition], null, { routingContext: context });
    assert.equal(result.route, 'workflow');
    assert.deepEqual(called, ['tev1:4b', 'chosen-chat']);
    assert.equal(context.trace.escalated, true);
    assert.equal(context.trace.decisionSource, 'chat_model');
    assert.equal(context.executionBudget.modelCalls, 7);
    assert.equal(context.trace.stages.length, 2);
  });
}

test('local_tev1 timeout bounds a noncooperative adapter and does not fallback', async t => {
  const context = fixture(t, 'local_tev1', { CHAT_ROUTING_TIMEOUT_MS: '20' });
  const mock = t.mock.method(adapters, 'dispatchToProvider', () => new Promise(() => {}));
  await assert.rejects(router.decide('Xin chào', [definition], null, { routingContext: context }), { code: 'ROUTING_TIMEOUT' });
  assert.equal(mock.mock.callCount(), 1);
  assert.equal(context.trace.escalated, false);
});

test('auto handles local timeout, but a chat failure never tries a third provider', async t => {
  const context = fixture(t, 'auto', { CHAT_ROUTING_TIMEOUT_MS: '20' });
  const called = [];
  t.mock.method(adapters, 'dispatchToProvider', provider => {
    called.push(provider.model);
    return called.length === 1 ? new Promise(() => {}) : Promise.reject(new Error('chat unavailable'));
  });
  await assert.rejects(router.decide('Xin chào', [definition], null, { routingContext: context }), { code: 'ROUTING_PROVIDER_ERROR' });
  assert.deepEqual(called, ['tev1:4b', 'chosen-chat']);
  assert.equal(context.trace.escalationReason, 'ROUTING_TIMEOUT');
});

test('caller cancellation never escalates or executes', async t => {
  const context = fixture(t, 'auto');
  const controller = new AbortController();
  const called = t.mock.method(adapters, 'dispatchToProvider', () => {
    controller.abort(); return new Promise(() => {});
  });
  await assert.rejects(router.decide('Xin chào', [definition], null, { routingContext: context, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called.mock.callCount(), 1);
  assert.equal(context.trace.escalated, false);
});

test('auto reserves budget for chat escalation and response before running TEV1', async t => {
  const context = fixture(t, 'auto');
  context.executionBudget = new RequestExecutionBudget({ maxModelCalls: 4 });
  const called = t.mock.method(adapters, 'dispatchToProvider', async provider => response(decision({ route: 'unclear' }), provider));
  await router.decide('Xin chào', [definition], null, { routingContext: context });
  assert.equal(called.mock.callCount(), 1);
  assert.equal(called.mock.calls[0].arguments[0].model, chatProvider.model);
  assert.equal(context.executionBudget.modelCalls, 1);
});

test('auto can escalate context overflow to a larger selected chat model without truncating catalog', async t => {
  const context = fixture(t, 'auto');
  context.routingProviderSnapshot = { ...context.routingProviderSnapshot, contextWindow: 256 };
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async provider => { calls.push(provider.model); return response(decision(), provider); });
  await router.decide('Xin chào', [definition], null, { routingContext: context });
  assert.deepEqual(calls, ['chosen-chat']);
  assert.equal(context.trace.escalationReason, 'ROUTING_CONTEXT_EXCEEDED');
});

test('configuration rejects invalid mode, timeout, model, endpoint and missing explicit provider', t => {
  fixture(t);
  for (const [key, value] of [['CHAT_ROUTING_MODE', 'guess'], ['CHAT_ROUTING_TIMEOUT_MS', '0'],
    ['CHAT_ROUTING_LOCAL_MODEL', ' '], ['CHAT_ROUTING_LOCAL_BASE_URL', 'http://user:secret@localhost']]) {
    const previous = process.env[key]; process.env[key] = value;
    assert.throws(() => router.createRoutingContext({ chatProviderSnapshot: chatProvider }), { code: 'ROUTING_CONFIG_INVALID' });
    process.env[key] = previous;
  }
  t.mock.method(providers, 'getProviderForExecution', () => null);
  assert.throws(() => router.createRoutingContext({ providerId: 'missing' }), { code: 'CHAT_PROVIDER_UNAVAILABLE' });
});

test('provider and mode changes during a request cannot change its snapshots', async t => {
  const context = fixture(t, 'auto');
  process.env.CHAT_ROUTING_MODE = 'chat_model';
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async provider => {
    calls.push(provider.model);
    return response(calls.length === 1 ? decision({ route: 'unclear' }) : decision(), provider);
  });
  await router.decide('Xin chào', [definition], null, { routingContext: context });
  assert.deepEqual(calls, ['tev1:4b', 'chosen-chat']);
  assert.equal(context.config.mode, 'auto');
});

const pending = { id: 'pending-1', templateId: definition.id, status: 'WAITING_INPUT', revision: 1,
  definition, input: {}, missing: [{ key: 'code', ask: 'Mã hợp đồng?' }], invalid: [] };
test('input contract rejects wrong run, unrelated schema-valid text, invented slots and unsupported values', () => {
  const valid = workflow('A001', { inputDisposition: 'slot_answer', pendingRunId: pending.id,
    inputs: { code: 'A001' }, inputEvidence: { code: 'A001' } });
  assert.equal(router.validateDecision(valid, 'A001', [definition], pending).inputDisposition, 'slot_answer');
  for (const overrides of [{ pendingRunId: 'wrong-run' }, { workflowId: other.id },
    { inputEvidence: { code: 'not in message' } }, { inputs: { secret: 'A001' }, inputEvidence: { secret: 'A001' } },
    { inputs: { code: 'invented' } }, { inputs: { code: 10 } }]) {
    assert.throws(() => router.validateDecision({ ...valid, ...overrides }, 'A001', [definition, other], pending), { code: 'ROUTING_INVALID_OUTPUT' });
  }
  assert.throws(() => router.validateDecision(valid, 'A001', [definition], null), { code: 'ROUTING_INVALID_OUTPUT' });
});

test('a bare pending value classified as a new operation never creates a duplicate run', () => {
  const result = router.validateDecision(workflow('A001', { inputs: { code: 'A001' }, inputEvidence: { code: 'A001' } }), 'A001', [definition], pending);
  assert.equal(result.route, 'unclear');
  assert.deepEqual(result.inputs, {});
  const empty = router.validateDecision(workflow('A001'), 'A001', [definition], pending);
  assert.equal(empty.route, 'unclear');
});

test('an aggregate cannot execute a targeted lookup and a listing cannot execute a totals report', () => {
  for (const [requestedScope, supportedScope] of [['aggregate', 'targeted'], ['collection', 'aggregate'], ['targeted', 'collection']]) {
    assert.equal(router.validateDecision(workflow('Business request', { requestedScope, supportedScope }), 'Business request', [definition], null).route, 'unclear');
  }
  const output = router.validateDecision(workflow('List every record', { requestedScope: 'collection', supportedScope: 'collection' }),
    'List every record', [{ ...definition, routingScope: 'targeted' }], null);
  assert.equal(output.route, 'unclear');
});

test('declared optional evidence without a supplied value does not fabricate workflow input', () => {
  const result = router.validateDecision(workflow('Tra cứu hợp đồng', { inputEvidence: { code: 'Tra cứu hợp đồng' } }), 'Tra cứu hợp đồng', [definition], null);
  assert.equal(result.route, 'workflow');
  assert.deepEqual(result.inputs, {});
  assert.deepEqual(result.inputEvidence, {});
});

function handleFixture(t, mode = 'local_tev1', current = null, extraEnv = {}) {
  const context = fixture(t, mode, extraEnv);
  t.mock.method(automation, 'settings', async () => ({ enabled: true }));
  t.mock.method(automation.registry, 'list', async () => [definition, other]);
  t.mock.method(automation.runtime, 'pending', async (_, __, id) => id ? null : current);
  const creates = t.mock.method(automation.runtime, 'create', async (id, inputs) => ({ id: 'created', templateId: id,
    name: id, status: Object.keys(inputs).length ? 'READY' : 'WAITING_INPUT', missingInputs: [{ ask: 'Mã hợp đồng?' }] }));
  const updates = t.mock.method(automation.runtime, 'inputs', async () => ({ id: current?.id, name: definition.name, status: 'READY' }));
  const cancels = t.mock.method(automation.runtime, 'cancel', async () => ({ id: current?.id, name: definition.name, status: 'CANCELLED' }));
  return { context, creates, updates, cancels, options: { routingContext: context, session: { id: 'conversation', accountId: 'actor' }, permissions: ['admin'] } };
}

for (const mode of ['local_tev1', 'chat_model']) test(`${mode} explains capabilities from metadata without modifying pending runs`, async t => {
  const f = handleFixture(t, mode, { id: 'waiting', templateId: other.id, status: 'WAITING_INPUT', definition: other, missing: [{ key: 'code' }], input: {} });
  const question = 'Which options does this operation support?';
  const metadata = { ...definition, capabilities: { summary: 'Public summary', timeGranularities: ['configured-period'], units: ['configured-unit'] } };
  t.mock.method(automation.registry, 'getTemplate', async id => { assert.equal(id, definition.id); return metadata; });
  let calls = 0;
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages, tools) => {
    calls++;
    if (calls === 1) return response(decision({ purpose: 'explain', workflowId: definition.id, evidence: [{ source: 'user_message', text: question }] }), provider);
    assert.deepEqual(tools, []); assert.equal(provider.model, chatProvider.model);
    const payload = JSON.parse(messages[1].content);
    assert.deepEqual(payload.workflow.capabilities, metadata.capabilities);
    assert.equal(payload.workflow.workflow, undefined);
    return { content: 'Configured options explained.', usage: { calls: 1 } };
  });
  const result = await orchestrator.handle(question, f.options);
  assert.equal(result.replyText, 'Configured options explained.');
  assert.equal(result.execution, undefined);
  assert.equal(f.context.decision.purpose, 'explain');
  assert.equal(f.creates.mock.callCount(), 0); assert.equal(f.updates.mock.callCount(), 0); assert.equal(f.cancels.mock.callCount(), 0);
});

test('purpose contract rejects explanation disguised as execution and unauthorized explanation', () => {
  const question = 'Available options?';
  assert.throws(() => router.validateDecision(workflow(question, { purpose: 'explain' }), question, [definition], null), { code: 'ROUTING_INVALID_OUTPUT' });
  const explain = decision({ purpose: 'explain', workflowId: definition.id, evidence: [{ source: 'user_message', text: question }] });
  assert.throws(() => router.validateDecision(explain, question, [other], null), { code: 'ROUTING_INVALID_OUTPUT' });
  assert.throws(() => router.validateDecision({ ...explain, cancelPending: true }, question, [definition], null), { code: 'ROUTING_INVALID_OUTPUT' });
  assert.throws(() => router.validateDecision({ ...explain, inputs: { code: 'Available' }, inputEvidence: { code: 'Available' } }, question, [definition], null), { code: 'ROUTING_INVALID_OUTPUT' });
});

test('an explicit reviewed entity list bypasses workflow selection and preserves pending runs', async t => {
  const f = handleFixture(t);
  t.mock.method(require('../src/backend/intelligent_core/schema_context_service'), 'explicitListTable', () => ({ tableName: 'T_Contract' }));
  const model = t.mock.method(adapters, 'dispatchToProvider', async () => { throw new Error('No model routing for an explicit list'); });
  assert.equal(await orchestrator.handle('ds hđ', f.options), null);
  assert.equal(f.context.trace.reason, 'explicit_entity_list');
  assert.equal(model.mock.callCount(), 0);
  assert.equal(f.creates.mock.callCount(), 0);
  assert.equal(f.updates.mock.callCount(), 0);
});

for (const question of ['nhân viên trên có giới tính là gì', 'giới tính nv trên là gì']) {
  test(`completed workflow memory prevents a new lookup for: ${question}`, async t => {
    const pending = { id: 'pending', templateId: other.id, status: 'WAITING_INPUT', definition: other,
      input: {}, missing: [{ key: 'code', ask: 'Mã nhân viên?' }], invalid: [] };
    const f = handleFixture(t, 'local_tev1', pending, { CHAT_QUICK_GREETING_ENABLED: 'true' });
    f.options.workflowMemory = { runId: 'completed', name: 'Tra cứu nhân viên', inputs: { code: 'NV007' },
      datasets: [{ field: 'employees', columns: ['EmployeeCode', 'GenderID'], rowCount: 1 }] };
    const model = t.mock.method(adapters, 'dispatchToProvider', async provider => {
      const task = provider.decisionTask;
      assert.equal(task.state.completedWorkflow.runId, 'completed');
      assert.deepEqual(Object.keys(task.questions), ['route']);
      return { content: JSON.stringify({ answers: { route: { type: 'choice', choice: 'memory_question',
        probabilities: { memory_question: 0.9, new_request: 0.1 } } } }), usage: { calls: 1 } };
    });
    assert.equal(await orchestrator.handle(question, f.options), null);
    assert.equal(f.context.trace.reason, 'completed_workflow_followup');
    assert.equal(f.context.trace.memoryRunId, 'completed');
    assert.equal(model.mock.callCount(), 1);
    assert.equal(f.creates.mock.callCount(), 0);
    assert.equal(f.updates.mock.callCount(), 0);
    assert.equal(f.cancels.mock.callCount(), 0);
  });
}

test('uncertain memory classification escalates with completed context before starting a workflow', async t => {
  const f = handleFixture(t, 'auto');
  f.options.workflowMemory = { runId: 'completed', name: 'Employee lookup', inputs: { code: 'NV007' },
    datasets: [{ field: 'employees', columns: ['GenderID'], rowCount: 1 }] };
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    calls.push(provider.model);
    if (provider.decisionTask) return { content: JSON.stringify({ answers: { route: {
      type: 'choice', choice: 'memory_question', probabilities: { memory_question: 0.55, new_request: 0.45 }
    } } }), usage: { calls: 1 } };
    assert.equal(JSON.parse(messages[1].content).completedWorkflow.runId, 'completed');
    return response(decision(), provider);
  });
  assert.equal(await orchestrator.handle('giới tính nv trên là gì', f.options), null);
  assert.deepEqual(calls, ['tev1:4b', 'chosen-chat']);
  assert.equal(f.context.trace.escalationReason, 'ambiguous_memory_followup');
  assert.equal(f.creates.mock.callCount(), 0);
});

for (const question of ['thông tin chi tiết hợp đồng', 'thông tin chi tiết hđ', 'chi tiết hđ', 'thông tin chi tiết hđ 02/HĐTQSDĐ.LG.2010']) {
  test(`a standalone contract lookup is not intercepted by old workflow memory: ${question}`, async t => {
    const f = handleFixture(t, 'local_tev1');
    f.options.workflowMemory = { runId: 'old-employee', name: 'Employee lookup', inputs: { code: 'NV007' },
      datasets: [{ field: 'employees', columns: ['GenderID'], rowCount: 1 }] };
    t.mock.method(adapters, 'dispatchToProvider', async provider => {
      assert.equal(provider.decisionTask.state.completedWorkflow, undefined);
      const code = question.includes('02/HĐTQSDĐ.LG.2010') ? '02/HĐTQSDĐ.LG.2010' : null;
      return response(workflow(question, code ? { inputs: { code }, inputEvidence: { code } } : {}), provider);
    });
    const result = await orchestrator.handle(question, f.options);
    assert.equal(result.execution.templateId, definition.id);
    assert.equal(f.creates.mock.callCount(), 1);
    assert.equal(f.context.trace.reason, undefined);
  });
}

test('uncertain extraction of a supplied compound code is verified before workflow creation', async t => {
  const f = handleFixture(t, 'auto');
  const question = 'chi tiết hđ 02/HĐTQSDĐ.LG.2010';
  const code = '02/HĐTQSDĐ.LG.2010';
  const chosen = workflow(question, { inputs: { code }, inputEvidence: { code } });
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async provider => {
    calls.push(provider.model);
    const result = response(chosen, provider);
    if (provider.decisionTask) {
      const payload = JSON.parse(result.content);
      const input = payload.answers.input_0;
      const options = Object.keys(input.probabilities);
      input.probabilities = Object.fromEntries(options.map(key => [key, key === input.choice ? 0.57 : 0.43 / (options.length - 1)]));
      payload.answers.provided_0 = { type: 'choice', choice: 'no', probabilities: { no: 0.73, yes: 0.27 } };
      result.content = JSON.stringify(payload);
    }
    return result;
  });
  const result = await orchestrator.handle(question, f.options);
  assert.equal(result.execution.status, 'READY');
  assert.equal(f.context.trace.escalationReason, 'uncertain_input_extraction');
  assert.deepEqual(calls, ['tev1:4b', 'chosen-chat']);
  assert.deepEqual(f.creates.mock.calls[0].arguments[1], { code });
  assert.equal(f.creates.mock.callCount(), 1);
});

test('quick greeting uses one TEV1 evaluation and fixed reply without chat or pending mutations', async t => {
  const f = handleFixture(t, 'auto', pending, { CHAT_QUICK_GREETING_ENABLED: 'true' });
  const calls = t.mock.method(adapters, 'dispatchToProvider', async provider => {
    assert.equal(provider.apiFormat, 'ollama-decision');
    assert.deepEqual(Object.keys(provider.decisionTask.questions), ['route']);
    return { content: JSON.stringify({ answers: { route: { type: 'choice', choice: 'greeting', probabilities: { greeting: 0.96, chat: 0.04 } } } }),
      usage: { inputTokens: 50, outputTokens: 1, totalTokens: 51, calls: 1 } };
  });
  const result = await orchestrator.handle('hello', f.options);
  assert.match(result.replyText, /Chào bạn/);
  assert.equal(result.executionMode, 'chat');
  assert.equal(result.trace.workflowRouting.quickReplyKind, 'greeting');
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(result.tokenUsage.calls, 1);
  assert.equal(f.context.executionBudget.modelCalls, 1);
  assert.equal(f.creates.mock.callCount(), 0);
  assert.equal(f.updates.mock.callCount(), 0);
  assert.equal(f.cancels.mock.callCount(), 0);
});

test('greeting plus business request continues full routing after the greeting probe', async t => {
  const f = handleFixture(t, 'auto', null, { CHAT_QUICK_GREETING_ENABLED: 'true' });
  const question = 'hello, Tra cứu hợp đồng';
  let count = 0;
  t.mock.method(adapters, 'dispatchToProvider', async provider => ++count === 1
    ? response(decision(), provider) : response(workflow(question), provider));
  const result = await orchestrator.handle(question, f.options);
  assert.equal(count, 2);
  assert.equal(result.execution.templateId, definition.id);
  assert.equal(result.trace.workflowRouting.quickReplyKind, undefined);
});

test('uncertain greeting classification continues routing instead of replying with a greeting', async t => {
  const f = handleFixture(t, 'auto', null, { CHAT_QUICK_GREETING_ENABLED: 'true' });
  let count = 0;
  t.mock.method(adapters, 'dispatchToProvider', async provider => ++count === 1
    ? { content: JSON.stringify({ answers: { route: { type: 'choice', choice: 'greeting', probabilities: { greeting: 0.55, chat: 0.45 } } } }) }
    : response(decision(), provider));
  assert.equal(await orchestrator.handle('hi?', f.options), null);
  assert.equal(count, 2);
});

test('routing selects workflow before asking inputs and keeps chat provider visible', async t => {
  const f = handleFixture(t);
  t.mock.method(adapters, 'dispatchToProvider', async provider => response(workflow('Tra cứu hợp đồng'), provider));
  const result = await orchestrator.handle('Tra cứu hợp đồng', f.options);
  assert.equal(result.execution.status, 'WAITING_INPUT');
  assert.equal(f.creates.mock.callCount(), 1);
  assert.equal(result.usedProvider.model, 'chosen-chat');
  assert.equal(result.trace.workflowRouting.routingModel, 'tev1:4b');
  assert.equal(result.trace.executionBudget.modelCalls, 7);
  assert.equal(result.tokenUsage.totalTokens, 15);
});

test('new request uses full catalog in one decision and does not update pending run', async t => {
  const f = handleFixture(t, 'local_tev1', pending);
  const calls = t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.catalog.length, 2);
    assert.equal(payload.current.id, pending.id);
    return response(workflow('Tra cứu nhân viên E001', { workflowId: other.id,
      inputs: { code: 'E001' }, inputEvidence: { code: 'E001' } }), provider);
  });
  const result = await orchestrator.handle('Tra cứu nhân viên E001', f.options);
  assert.equal(result.execution.templateId, other.id);
  assert.equal(calls.mock.callCount(), 1);
  assert.equal(f.updates.mock.callCount(), 0);
  assert.equal(f.cancels.mock.callCount(), 0);
  assert.equal(f.creates.mock.calls[0].arguments[3].preservePending, true);
});

test('valid slot answer updates only the matching pending run', async t => {
  const f = handleFixture(t, 'local_tev1', pending);
  t.mock.method(adapters, 'dispatchToProvider', async provider => response(workflow('A001', {
    inputDisposition: 'slot_answer', pendingRunId: pending.id, inputs: { code: 'A001' }, inputEvidence: { code: 'A001' }
  }), provider));
  await orchestrator.handle('A001', f.options);
  assert.equal(f.updates.mock.calls[0].arguments[0], pending.id);
  assert.deepEqual(f.updates.mock.calls[0].arguments[1], { code: 'A001' });
  assert.equal(f.creates.mock.callCount(), 0);
});

for (const value of ['unclear', 'unknown_id', 'scope_conflict', 'provider_error']) {
  test(`${value} never creates or mutates workflow in local_tev1`, async t => {
    const f = handleFixture(t, 'local_tev1', pending);
    t.mock.method(adapters, 'dispatchToProvider', async provider => {
      if (value === 'provider_error') throw new Error('secret');
      if (value === 'unclear') return response(decision({ route: 'unclear', candidateIds: [definition.id, other.id] }), provider);
      return response(workflow('Tra cứu hợp đồng', value === 'unknown_id' ? { workflowId: 'unknown' } : { requestedScope: 'collection' }), provider);
    });
    const result = await orchestrator.handle('Tra cứu hợp đồng', f.options);
    assert.ok(result);
    assert.equal(f.creates.mock.callCount(), 0);
    assert.equal(f.updates.mock.callCount(), 0);
    assert.equal(f.cancels.mock.callCount(), 0);
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
}

test('auto waits for chat decision before creating workflow; final chat keeps pending run untouched', async t => {
  const f = handleFixture(t, 'auto', pending);
  let calls = 0;
  t.mock.method(adapters, 'dispatchToProvider', async provider => {
    assert.equal(f.creates.mock.callCount(), 0);
    assert.equal(f.updates.mock.callCount(), 0);
    return response(++calls === 1 ? decision({ route: 'unclear', candidateIds: [definition.id] }) : decision(), provider);
  });
  assert.equal(await orchestrator.handle('Hợp đồng là gì?', f.options), null);
  assert.equal(calls, 2);
  assert.equal(f.cancels.mock.callCount(), 0);
});

for (const finalResult of ['unclear', 'invalid_json', 'provider_error']) {
  test(`auto asks user to select workflow on ${finalResult} without entering free SQL chat or mutating pending run`, async t => {
    const f = handleFixture(t, 'auto', pending);
    let calls = 0;
    t.mock.method(adapters, 'dispatchToProvider', async provider => {
      calls += 1;
      if (calls === 1) return response(decision({ route: 'unclear' }), provider);
      if (finalResult === 'invalid_json') return { content: '{broken' };
      if (finalResult === 'provider_error') throw new Error('offline');
      return response(decision({ route: 'unclear', candidateIds: [definition.id] }), provider);
    });
    const result = await orchestrator.handle('thông tin chi tiết nv', f.options);
    assert.equal(result.success, true);
    assert.equal(result.completionStatus, 'PARTIAL'); assert.equal(result.execution, undefined);
    assert.equal(calls, 2);
    assert.equal(f.creates.mock.callCount(), 0);
    assert.equal(f.updates.mock.callCount(), 0);
    assert.equal(f.cancels.mock.callCount(), 0);
  });
}

test('flow selection uses one TEV1 evaluation without workflow catalog', async t => {
  const context = fixture(t);
  let requests = 0;
  t.mock.method(adapters, 'dispatchToProvider', async provider => {
    requests++;
    assert.equal(Object.keys(provider.decisionTask.questions).length, 1);
    assert.equal(provider.decisionTask.state.workflows, undefined);
    assert.equal(provider.decisionTask.state.history.length, 2);
    assert.ok(provider.decisionTask.state.history.every(item => item.content.length <= 500));
    return response({ route: 'knowledge' }, provider);
  });
  const result = await router.classifyFlow('Show how to install our mobile application', { routingContext: context,
    history: Array.from({ length: 10 }, () => ({ role: 'user', content: 'x'.repeat(4000) })) });
  assert.equal(result.flow, 'knowledge');
  assert.equal(requests, 1);
  assert.equal(context.executionBudget.modelCalls, 1);
  assert.equal(context.trace.stages[0].stage, 'flow_selection');
});

test('uncertain flow escalates with a small prompt and shared budget in auto mode', async t => {
  const context = fixture(t, 'auto');
  const calls = [];
  t.mock.method(adapters, 'dispatchToProvider', async (provider, messages) => {
    calls.push(provider.model);
    if (provider.decisionTask) return response({ route: 'unclear' }, provider);
    assert.equal(messages.length, 2);
    assert.doesNotMatch(JSON.stringify(messages), /contracts\/detail/);
    return { content: JSON.stringify({ flow: 'knowledge' }), usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125 } };
  });
  const result = await router.classifyFlow('How do I install the app?', { routingContext: context });
  assert.equal(result.flow, 'knowledge');
  assert.deepEqual(calls, ['tev1:4b', 'chosen-chat']);
  assert.equal(context.executionBudget.modelCalls, 2);
  assert.equal(context.trace.escalated, true);
});

test('flow classifier rejects invented routes instead of loading arbitrary executors', async t => {
  const context = fixture(t, 'chat_model');
  t.mock.method(adapters, 'dispatchToProvider', async () => ({ content: '{"flow":"invented"}' }));
  await assert.rejects(router.classifyFlow('Question', { routingContext: context }), { code: 'ROUTING_INVALID_OUTPUT' });
});

test('flow selection also recognizes greeting in a single TEV1 evaluation', async t => {
  const context = fixture(t, 'local_tev1', { CHAT_QUICK_GREETING_ENABLED: 'true' });
  t.mock.method(adapters, 'dispatchToProvider', async provider => response({ route: 'greeting' }, provider));
  const result = await router.classifyFlow('hello', { routingContext: context });
  assert.equal(result.flow, 'chat');
  assert.equal(result.quickGreeting, true);
  assert.equal(context.executionBudget.modelCalls, 1);
});
