const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChatDiagnostics } = require('../src/backend/utils/chat_diagnostics');

test('audit captures rejection decisions without raw prompts or SQL', () => {
  const result = buildChatDiagnostics({ iterations: 7, training: {
    plan: { table: 'Customers', question: 'private question' },
    sqlEvaluations: [{ valid: false, violations: ['UNREQUESTED_FILTER'] }]
  }, steps: [{ type: 'UNREQUESTED_FILTER', sql: 'private query', error: 'private payload' }] });
  assert.equal(result.plan.table, 'Customers');
  assert.deepEqual(result.sqlEvaluations[0].violations, ['UNREQUESTED_FILTER']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('audit keeps routing mode, models and escalation without prompts, inputs or credentials', () => {
  const result = buildChatDiagnostics({ workflowRouting: { requestId: 'request', routingMode: 'auto',
    decisionSource: 'chat_model', routingModel: 'chosen-model', chatModel: 'chosen-model',
    escalated: true, escalationReason: 'ambiguous_intent', inputs: { code: 'private input' }, apiKey: 'private credential',
    stages: [{ decisionSource: 'local_tev1', model: 'tev1:4b', status: 'done', calls: 6,
      httpRequests: 1, decisionEvaluations: 6, inputTokens: 100, prompt: 'private prompt' }] } });
  assert.equal(result.workflowRouting.escalated, true);
  assert.equal(result.workflowRouting.stages[0].httpRequests, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
