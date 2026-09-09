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
