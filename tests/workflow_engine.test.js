const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowEngine = require('../src/backend/agent_core/workflows/workflow_engine');
const { createStep } = require('../src/backend/agent_core/workflows/automation_steps');

test('automation workflow transforms state and evaluates conditions', async () => {
  const workflow = new WorkflowEngine({ id: 'test', name: 'Test' });
  workflow.addStep(createStep({ id: 'mapped', type: 'transform', config: { mapping: { value: '{{input.amount}}' } } }));
  workflow.addStep(createStep({ id: 'check', type: 'condition', config: { left: '{{mapped.value}}', operator: 'greaterThan', right: 10 } }));
  const result = await workflow.run({ input: { amount: 12 } });
  assert.equal(result.success, true);
  assert.deepEqual(result.state.mapped, { value: 12 });
  assert.equal(result.state.check, true);
});

test('workflow catches condition errors in trace', async () => {
  const workflow = new WorkflowEngine({ id: 'test', name: 'Test' });
  workflow.addStep(createStep({ id: 'delay', type: 'delay', config: { delayMs: 0 } }), () => { throw new Error('condition failed'); });
  const result = await workflow.run();
  assert.equal(result.success, false);
  assert.equal(result.trace.error, 'condition failed');
});

test('workflow retries a failed step', async () => {
  let attempts = 0;
  const workflow = new WorkflowEngine({ id: 'retry', name: 'Retry' });
  workflow.addStep({ id: 'unstable', name: 'Unstable', retry: { maxAttempts: 2 }, async execute() {
    attempts++;
    if (attempts === 1) throw new Error('temporary');
    return { recovered: true };
  }});
  const result = await workflow.run();
  assert.equal(result.success, true);
  assert.equal(result.state.recovered, true);
  assert.equal(attempts, 2);
});
