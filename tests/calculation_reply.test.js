'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCalculationReply } = require('../src/backend/agent_core/harness/calculation_reply');

const call = {
  toolName: 'calculate_expression', success: true,
  args: { expression: '34 + 34' }, result: { expression: '34 + 34', value: 68 }
};

test('plain arithmetic answer does not invent a unit or dollar delimiter', () => {
  const reply = buildCalculationReply('34+34', call);
  assert.equal(reply, 'Kết quả của phép tính **34 + 34** là **68**.');
  assert.doesNotMatch(reply, /\$/);
});

test('calculation answer preserves a unit only when the user supplied it', () => {
  assert.match(buildCalculationReply('34 USD + 34 USD', call), /\*\*68 USD\*\*/i);
  assert.match(buildCalculationReply('$34 + $34', call), /\*\*\$68\*\*/);
});
