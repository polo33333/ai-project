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

test('forecast analysis survives a supporting arithmetic tool result', () => {
  const core = require('../src/backend/intelligent_core/core');
  const analysis = 'Sản lượng giảm từ 3.322.035 xuống 1.868.033 kWh. Chỉ có 2 tháng dữ liệu nên chưa đủ để dự báo tin cậy cho 3 tháng sau.';
  const result = core._buildSuccessResponse(
    'dựa vào dữ liệu sản lượng trên dự đoán xu hướng trong 3 tháng sau', analysis,
    [{ toolName: 'calculate_expression', success: true,
      args: { expression: '1868033 - 3322035' }, result: { value: -1454002 } }],
    { id: 'fixture', name: 'Fixture', model: 'fixture', type: 'remote' }
  );
  assert.equal(result.replyText, analysis);
  assert.equal(result.calcResult.value, -1454002);
});

test('plain arithmetic response remains grounded in the executed result', () => {
  const core = require('../src/backend/intelligent_core/core');
  const result = core._buildSuccessResponse('34+34', 'Wrong model answer: 99', [call],
    { id: 'fixture', name: 'Fixture', model: 'fixture', type: 'remote' });
  assert.equal(result.replyText, 'Kết quả của phép tính **34 + 34** là **68**.');
});
