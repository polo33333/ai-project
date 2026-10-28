'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTemporalGrounding, groundTemporalQuery, rankResultsForTemporalGrounding
} = require('../src/backend/services/web_search_service');
const { isShortContextualFollowup } = require('../src/backend/memory/memory_policy');
const ToolManager = require('../src/backend/agent/tools/tool_manager');

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
