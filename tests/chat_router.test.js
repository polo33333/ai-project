'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/backend/automation/chat_router');
const adapters = require('../src/backend/intelligent_core/adapters');
const providers = require('../src/backend/services/ai_provider_manager');
const automation = require('../src/backend/automation');
const orchestrator = require('../src/backend/automation/orchestrator');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');

const chatProvider = { id: 'chosen', name: 'Chosen chat', model: 'chosen-chat', type: 'openai', apiFormat: 'openai',
  executionClass: 'remote', baseUrl: 'https://chosen.invalid/v1', apiKey: 'test-secret', contextWindow: 32768 };
const definition = { id: 'contracts/detail', name: 'Tra cứu hợp đồng', description: 'Tra cứu chi tiết hợp đồng theo mã',
  inputs: { code: { required: true, ask: 'Mã hợp đồng?', schema: { type: 'string', minLength: 1 } } } };
const other = { id: 'employees/detail', name: 'Tra cứu nhân viên', description: 'Tra cứu nhân viên theo mã', inputs: definition.inputs };
function decision(overrides = {}) {
  return { route: 'chat', workflowId: null, candidateIds: [], inputDisposition: 'none', pendingRunId: null,
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
      : value.route === 'workflow' ? value.workflowId === definition.id ? 'w0' : value.workflowId === other.id ? 'w1' : 'unauthorized'
        : value.abstain ? 'unclear' : value.route;
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
    assert.equal(context.executionBudget.modelCalls, mode === 'chat_model' ? 1 : 6);
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
    assert.equal(context.executionBudget.modelCalls, 6);
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
  assert.equal(result.trace.executionBudget.modelCalls, 6);
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
    assert.equal(result.execution.status, 'SELECT_TEMPLATE');
    assert.equal(calls, 2);
    assert.equal(f.creates.mock.callCount(), 0);
    assert.equal(f.updates.mock.callCount(), 0);
    assert.equal(f.cancels.mock.callCount(), 0);
  });
}
