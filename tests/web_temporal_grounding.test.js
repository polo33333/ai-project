'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTemporalGrounding, groundTemporalQuery, rankResultsForTemporalGrounding
} = require('../src/backend/services/web_search_service');
const { isShortContextualFollowup } = require('../src/backend/memory_core/memory_policy');
const { hasTemporalGroundingMismatch } = require('../src/backend/agent_core/harness/local_model_harness');
const LocalModelHarness = require('../src/backend/agent_core/harness/local_model_harness');
const ToolManager = require('../src/backend/agent_core/tools/tool_manager');

test('Vietnamese temporal web query resolves năm nay to the current Vietnam year', () => {
  const now = new Date('2026-09-10T07:00:00.000Z');
  const grounding = getTemporalGrounding('vậy trung thu năm nay là ngày nào', now);
  assert.equal(grounding.year, 2026);
  assert.equal(grounding.required, true);
  assert.equal(groundTemporalQuery('vậy trung thu năm nay là ngày nào', grounding), 'vậy trung thu năm 2026 là ngày nào');
});

test('temporal result ranking puts the requested year before conflicting years', () => {
  const results = [
    { title: 'Trung thu 2025', snippet: '' },
    { title: 'Thông tin Trung thu', snippet: '' },
    { title: 'Tết Trung thu 2026', snippet: '' }
  ];
  assert.deepEqual(
    rankResultsForTemporalGrounding(results, { required: true, year: 2026 }).map(item => item.title),
    ['Tết Trung thu 2026', 'Thông tin Trung thu', 'Trung thu 2025']
  );
});

test('vậy is treated as a contextual follow-up', () => {
  assert.equal(isShortContextualFollowup('vậy trung thu năm nay là ngày nào'), true);
});

test('final answer rejects another year when the requested current year is absent', () => {
  const grounding = { required: true, year: 2026, timezone: 'Asia/Ho_Chi_Minh' };
  assert.equal(hasTemporalGroundingMismatch('Tết Trung thu năm nay là năm 2025.', grounding), true);
  assert.equal(hasTemporalGroundingMismatch('Tết Trung thu năm 2026 rơi vào tháng 9.', grounding), false);
});

test('non-web requests accept a null temporal grounding', () => {
  assert.equal(hasTemporalGroundingMismatch('Xin chào', null), false);
});

test('local harness asks the model to repair a wrong current-year web answer', async () => {
  let calls = 0;
  const harness = new LocalModelHarness({
    toolManager: new ToolManager(),
    maxIterations: 2,
    dispatch: async () => ({ content: ++calls === 1 ? 'Năm nay là năm 2025.' : 'Năm nay là năm 2026.' })
  });
  const result = await harness.run({
    userMessage: 'trung thu năm nay là ngày nào',
    messages: [{ role: 'system', content: 'Use web results.' }, { role: 'user', content: 'trung thu năm nay là ngày nào' }],
    provider: { id: 'local-test', type: 'local', apiFormat: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'test' },
    enabledToolNames: [],
    context: { webSearch: true, webTemporalGrounding: { required: true, year: 2026, timezone: 'Asia/Ho_Chi_Minh' } }
  });
  assert.equal(calls, 2);
  assert.match(result.replyText, /2026/);
  assert.equal(result.trace.steps.some(step => step.type === 'TEMPORAL_WEB_GROUNDING_MISMATCH'), true);
});
