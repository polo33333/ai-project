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

test('SQL evidence audit records acceptance and causes without result rows or query text', () => {
  const result = buildChatDiagnostics({ sqlEvidence: [{ index: 2, toolName: 'execute_sql_query',
    sql: 'private query', assessment: { accepted: false, failures: ['SQL_AGGREGATION_REQUIRED'], rows: [{ private: 1 }] } }],
    steps: [{ type: 'SQL_EVIDENCE_ASSESSED', accepted: false, failures: ['SQL_AGGREGATION_REQUIRED'], sql: 'private query' }] });
  assert.deepEqual(result.sqlEvidence, [{ index: 2, toolName: 'execute_sql_query', accepted: false, failures: ['SQL_AGGREGATION_REQUIRED'] }]);
  assert.equal(result.steps[0].accepted, false);
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
