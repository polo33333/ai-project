'use strict';
// Commentary on a summary result is kept only when every number it cites
// appears in the rows the user sees.
const test = require('node:test');
const assert = require('node:assert/strict');
const { narrate, verify, eligible } = require('../src/backend/agent_core/pipeline/narration');

const compiled = { operation: 'aggregate', analysis: 'none', scope: ['Ngày chứng từ: 01/02/2024 – trước 01/03/2024'],
  outputs: [{ alias: 'Khách hàng', kind: 'dimension' }, { alias: 'Tổng tiền', kind: 'measure' }] };
const call = { result: { rows: [{ 'Khách hàng': 'Công ty A', 'Tổng tiền': 6652704 }, { 'Khách hàng': 'Công ty B', 'Tổng tiền': 1250000.5 }], hasMore: false } };

test('numbers are checked against the shown rows in Vietnamese formats', () => {
  const rows = call.result.rows;
  assert.equal(verify('Công ty A cao nhất với 6.652.704, gấp nhiều lần Công ty B (1.250.000,5).', rows, compiled.scope).valid, true);
  assert.equal(verify('Có 2 khách hàng trong tháng 02/2024.', rows, compiled.scope).valid, true);
  assert.deepEqual(verify('Công ty A chiếm 84% tổng tiền.', rows, compiled.scope).unknown, ['84']);
  assert.deepEqual(verify('Tổng cộng 7.902.704,5.', rows, compiled.scope).unknown, ['7.902.704,5']);
});

test('a checked commentary is returned; one with a new number is dropped', async () => {
  const steps = [];
  const step = (type, data) => steps.push({ type, ...data });
  const good = await narrate({ compiled, call, question: 'Khách hàng nào có tiền cao nhất tháng 2024-02?', step,
    dispatch: async (definitions, messages, stage) => {
      assert.equal(definitions.length, 0); assert.equal(stage, 'v2_narration');
      assert.match(messages[1].content, /6\.652\.704/);
      return { content: 'Công ty A dẫn đầu với 6.652.704, cao hơn hẳn Công ty B.' };
    } });
  assert.equal(good, 'Công ty A dẫn đầu với 6.652.704, cao hơn hẳn Công ty B.');
  const bad = await narrate({ compiled, call, question: 'q', step, dispatch: async () => ({ content: 'Công ty A chiếm 84% tổng.' }) });
  assert.equal(bad, null);
  assert.deepEqual(steps.map(item => item.accepted), [true, false]);
  // A failed model call never breaks the answer.
  assert.equal(await narrate({ compiled, call, question: 'q', step, dispatch: async () => { throw new Error('HTTP 503'); } }), null);
});

test('only multi-row summaries get a commentary', () => {
  assert.equal(eligible(compiled, call), true);
  assert.equal(eligible({ ...compiled, operation: 'list' }, call), false);
  assert.equal(eligible(compiled, { result: { rows: [call.result.rows[0]] } }), false);
  assert.equal(eligible({ ...compiled, analysis: 'anomaly' }, call), false);
  assert.equal(eligible(compiled, { result: { ...call.result, hasMore: true } }), false);
  process.env.V2_NARRATION = 'off';
  try { assert.equal(eligible(compiled, call), false); } finally { delete process.env.V2_NARRATION; }
});

test('month buckets reach the commentary as MM/YYYY, like the question would say', async () => {
  const monthly = { operation: 'aggregate', analysis: 'none', scope: [],
    outputs: [{ alias: 'Tháng', kind: 'dimension', grain: 'month' }, { alias: 'Tổng', kind: 'measure' }] };
  const rows = [{ 'Tháng': new Date('2024-01-01T00:00:00Z'), 'Tổng': 10 }, { 'Tháng': new Date('2024-02-01T00:00:00Z'), 'Tổng': 12 }];
  let sent;
  const text = await narrate({ compiled: monthly, call: { result: { rows } }, question: 'Tổng theo tháng',
    dispatch: async (_definitions, messages) => { sent = JSON.parse(messages[1].content); return { content: 'Tháng 02/2024 cao hơn tháng 01/2024 (12 so với 10).' }; } });
  assert.deepEqual(sent.rows.map(row => row['Tháng']), ['01/2024', '02/2024']);
  assert.equal(text, 'Tháng 02/2024 cao hơn tháng 01/2024 (12 so với 10).');
});
