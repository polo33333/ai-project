'use strict';
// Local-only prompt additions in steps/dispatch: skill and examples in the
// agent loop, schema-constrained JSON for the v2 planning stage, and the
// local context window. Remote providers must receive exactly what they did.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatch } = require('../src/backend/agent_core/harness/steps/dispatch');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
const requestTime = require('../src/backend/services/request_time');

const ENV_KEYS = ['LOCAL_MODEL_SKILL_CORE_ENABLED', 'LOCAL_MODEL_FEW_SHOT_ENABLED', 'LOCAL_MODEL_STRUCTURED_CONTRACT',
  'LOCAL_MODEL_NUM_CTX', 'LOCAL_MODEL_NUM_PREDICT', 'AI_PROVIDER_CONTEXT_WINDOW', 'AI_PROVIDER_OUTPUT_RESERVE'];
const remote = { id: 'gemini', name: 'Gemini', apiFormat: 'gemini', executionClass: 'remote', model: 'gemini-fixture', supportsToolCalling: true };
const local = { id: 'ollama', name: 'Ollama', apiFormat: 'ollama', executionClass: 'local', model: 'qwen3.5:9b', supportsToolCalling: true };
const sqlTool = { type: 'function', function: { name: 'execute_sql_query', description: 'Run SQL', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } } };
const contractSchema = { type: 'object', required: ['kind'], properties: { kind: { enum: ['data', 'chat'] }, root: { type: 'string' } } };
const planTool = { type: 'function', function: { name: 'plan_query', description: 'Return the query contract.', parameters: contractSchema } };
const planMessages = [{ role: 'system', content: 'You translate the question. Call plan_query only.' }, { role: 'user', content: 'QUESTION: doanh thu theo tháng' }];
const plan = { intent: 'aggregate_timeseries', table: 'Sales', metric: 'Amount', timeColumn: 'DocDate', aggregation: 'SUM',
  schemaColumns: ['DocDate', 'Amount'], outputs: { data: true } };

function withEnv(t, values) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function setup(provider, responses = []) {
  const calls = [];
  const time = requestTime.create('doanh thu theo tháng', new Date('2026-10-27T03:00:00Z'));
  const s = {
    harness: { dispatch: async (target, messages, definitions) => {
      calls.push({ provider: target, messages, definitions });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next || { role: 'assistant', content: 'ok' };
    } },
    context: {}, budget: new RequestExecutionBudget({ executionClass: 'remote', timeoutMs: 60000, maxModelCalls: 20 }),
    candidates: [provider], activeProvider: provider, plan: structuredClone(plan), requestTime: time, question: 'doanh thu theo tháng',
    toolContext: {}, policy: { dataRequired: true }, instruction: '', toolCalls: [], providerFallbacks: [], check: () => {},
    conversation: [{ role: 'system', content: `Shared rules.\n${requestTime.instruction(time)}` }, { role: 'user', content: 'doanh thu theo tháng' }],
    trace: { steps: [], iterations: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false } }
  };
  return { s, calls, dispatch: createDispatch(s) };
}

async function remoteRun() {
  const { s, calls, dispatch } = setup(remote);
  await dispatch([sqlTool]);
  await dispatch([planTool], planMessages, 'v2_contract');
  await dispatch([planTool], planMessages, 'v2_contract_repair');
  return { s, calls };
}

test('remote providers receive the same prompt whatever the local settings are', async t => {
  withEnv(t, { LOCAL_MODEL_SKILL_CORE_ENABLED: 'false', LOCAL_MODEL_FEW_SHOT_ENABLED: 'false', LOCAL_MODEL_STRUCTURED_CONTRACT: 'false' });
  const off = await remoteRun();
  withEnv(t, { LOCAL_MODEL_SKILL_CORE_ENABLED: 'true', LOCAL_MODEL_FEW_SHOT_ENABLED: 'true', LOCAL_MODEL_STRUCTURED_CONTRACT: 'true',
    LOCAL_MODEL_NUM_CTX: '1024', LOCAL_MODEL_NUM_PREDICT: '900' });
  const on = await remoteRun();
  assert.deepEqual(on.calls, off.calls);

  const [agent, contract] = on.calls;
  assert.equal(agent.provider, remote);
  assert.equal(contract.provider, remote);
  assert.deepEqual(agent.messages, on.s.conversation);
  assert.deepEqual(agent.definitions, [sqlTool]);
  assert.deepEqual(contract.definitions, [planTool]);
  // The request clock is its own system message after the stage rules.
  assert.deepEqual(contract.messages, [planMessages[0], { role: 'system', content: requestTime.instruction(on.s.requestTime) }, planMessages[1]]);
  assert.equal(on.s.trace.skill, undefined);
  assert.ok(!on.s.trace.steps.some(step => step.structuredOutput || step.type === 'LOCAL_STRUCTURED_OUTPUT_FAILED'));
  for (const call of on.calls) assert.doesNotMatch(JSON.stringify(call.messages), /Local tool protocol|Business skill|JSON schema/);
});

test('local planning stage asks for JSON constrained by the tool schema', async t => {
  withEnv(t, {});
  const { s, calls, dispatch } = setup(local, [{ role: 'assistant', content: '{"kind":"data","root":"Sales"}' }]);
  const response = await dispatch([planTool], planMessages, 'v2_contract');
  assert.equal(response.content, '{"kind":"data","root":"Sales"}');
  assert.deepEqual(calls[0].provider.responseFormat, contractSchema);
  assert.equal(calls[0].provider.id, local.id);
  assert.deepEqual(calls[0].definitions, []);
  // One leading system message: stage rules, the JSON instruction, then the clock.
  assert.equal(calls[0].messages.filter(message => message.role === 'system').length, 1);
  const system = calls[0].messages[0].content;
  assert.ok(system.startsWith(planMessages[0].content));
  assert.ok(system.includes(`Return only the plan_query arguments as one JSON object matching this JSON schema, with no tool call and no prose:\n${JSON.stringify(contractSchema)}`));
  assert.ok(system.endsWith(requestTime.instruction(s.requestTime)));
  assert.equal(s.activeProvider, local);
  assert.equal(s.trace.steps.find(step => step.type === 'MODEL_USAGE').structuredOutput, true);
});

test('local planning stage keeps native tool calls when structured output is turned off', async t => {
  withEnv(t, { LOCAL_MODEL_STRUCTURED_CONTRACT: 'false' });
  const { calls, dispatch } = setup(local);
  await dispatch([planTool], planMessages, 'v2_contract');
  assert.equal(calls[0].provider, local);
  assert.deepEqual(calls[0].definitions, [planTool]);
});

test('a rejected structured call retries the same local provider with its native tool call', async t => {
  withEnv(t, {});
  const { s, calls, dispatch } = setup(local, [new Error('Ollama HTTP 500: failed to load format'), { role: 'assistant', content: 'native' }]);
  const response = await dispatch([planTool], planMessages, 'v2_contract');
  assert.equal(response.content, 'native');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].definitions, [planTool]);
  assert.equal(calls[1].provider.responseFormat, undefined);
  assert.ok(s.trace.steps.some(step => step.type === 'LOCAL_STRUCTURED_OUTPUT_FAILED' && step.providerId === local.id));
  // The repair round goes straight to the native tool call.
  await dispatch([planTool], planMessages, 'v2_contract_repair');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].definitions, [planTool]);
});

test('local agent loop receives the business skill and reviewed examples', async t => {
  withEnv(t, { LOCAL_MODEL_SKILL_CORE_ENABLED: 'true', LOCAL_MODEL_FEW_SHOT_ENABLED: 'true' });
  const { s, calls, dispatch } = setup(local);
  await dispatch([sqlTool]);
  const system = calls[0].messages[0].content;
  assert.ok(system.startsWith(s.conversation[0].content));
  assert.match(system, /# Local tool protocol/);
  assert.match(system, /# Business skill \(aggregate_report@1\)/);
  assert.match(system, /# Reviewed examples[\s\S]*FORMAT\(\[DocDate\], 'yyyy-MM'\)/);
  assert.deepEqual(calls[0].definitions, [sqlTool]);
  assert.equal(s.trace.skill.injected, true);
  assert.equal(s.trace.skill.exampleCount, 1);
  // Stages without tools keep the shared prompt.
  await dispatch([], [{ role: 'system', content: 'Summarize.' }, { role: 'user', content: 'rows' }], 'final_synthesis');
  assert.doesNotMatch(calls[1].messages[0].content, /Local tool protocol/);
});

test('local agent loop gets the tool protocol without a skill when skills are off', async t => {
  withEnv(t, { LOCAL_MODEL_SKILL_CORE_ENABLED: 'false' });
  const { s, calls, dispatch } = setup(local);
  await dispatch([sqlTool]);
  assert.match(calls[0].messages[0].content, /# Local tool protocol/);
  assert.doesNotMatch(calls[0].messages[0].content, /Business skill|Reviewed examples/);
  assert.equal(s.trace.skill.status, 'disabled');
  assert.equal(s.trace.skill.injected, false);
});

test('local prompts are budgeted against the local context window', async t => {
  withEnv(t, { LOCAL_MODEL_NUM_CTX: '1024', AI_PROVIDER_CONTEXT_WINDOW: '16384' });
  const localRun = setup(local);
  await assert.rejects(localRun.dispatch([sqlTool]), error => error.code === 'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(localRun.calls.length, 0);
  const remoteRun = setup(remote);
  await remoteRun.dispatch([sqlTool]);
  assert.equal(remoteRun.calls.length, 1);
  // A provider-level window wins over the environment default.
  const wide = setup({ ...local, numCtx: 16384 });
  await wide.dispatch([sqlTool]);
  assert.equal(wide.calls.length, 1);
});
