'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleAnswer } = require('../src/backend/agent/harness/visible_answer');
test('only the final-answer block is user-visible, even with unmarked planning before it', () => {
  assert.equal(visibleAnswer("Let's formulate and verify the response. <final_answer>Customer information.</final_answer> Additional private notes"), 'Customer information.');
});
test('explicit reasoning blocks are not shown and unfinished blocks fail closed', () => {
  assert.equal(visibleAnswer('<think>private draft</think>Business answer.'), 'Business answer.');
  assert.equal(visibleAnswer('<analysis>private unfinished draft'), '');
  assert.equal(visibleAnswer('private draft <final_answer>unfinished'), '');
});
test('ordinary English business answers remain intact', () => {
  assert.equal(visibleAnswer('The company stores contact information.'), 'The company stores contact information.');
});
