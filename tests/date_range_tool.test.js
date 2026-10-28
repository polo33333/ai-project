'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../src/backend/agent/tools/date_range');

test('calendar ranges handle leap years, quarters, Monday weeks and year rollover', () => {
  const now = new Date('2024-03-01T10:00:00Z');
  const range = args => { const { start, end } = resolve(args, now); return [start, end]; };
  assert.deepEqual(range({ unit: 'month', offset: -1 }), ['2024-02-01', '2024-03-01']);
  assert.deepEqual(range({ unit: 'quarter', offset: -1 }), ['2023-10-01', '2024-01-01']);
  assert.deepEqual(range({ unit: 'week' }), ['2024-02-26', '2024-03-04']);
  assert.deepEqual(range({ unit: 'month', count: 3 }), ['2024-01-01', '2024-04-01']);
});

test('local dates respect timezone boundaries', () => {
  const now = new Date('2026-10-17T18:00:00Z');
  assert.equal(resolve({ unit: 'day' }, now).start, '2026-10-18');
  assert.equal(resolve({ unit: 'day', timezone: 'America/Los_Angeles' }, now).start, '2026-10-17');
});

test('small-data and retrieval bounds match across both tool definitions', () => {
  const registry = require('../src/backend/assistant/tool_registry');
  const { CalculateStatsTool, SearchKnowledgeTool } = require('../src/backend/agent/tools/builtins');
  for (const tool of [new CalculateStatsTool(), new SearchKnowledgeTool()]) {
    const spec = registry.listTools([tool.name])[0];
    assert.deepEqual(tool.parameters, spec.parameters);
    if (tool.name === 'calculate_stats') {
      assert.equal(tool.validateArgs({ data: [], operation: 'all' }).valid, false);
      assert.equal(tool.validateArgs({ data: Array(1001).fill(1), operation: 'sum' }).valid, false);
    } else {
      assert.equal(tool.validateArgs({ query: 'test', limit: 1.5 }).valid, false);
      assert.equal(tool.validateArgs({ query: 'test', limit: 21 }).valid, false);
    }
  }
});

test('date tool is available through both execution paths and rejects invalid arguments', async () => {
  const registry = require('../src/backend/assistant/tool_registry');
  const { defaultToolManager } = require('../src/backend/agent');
  assert.equal((await registry.executeTool('resolve_date_range', { unit: 'year' })).success, true);
  assert.equal((await defaultToolManager.executeTool('resolve_date_range', { unit: 'day' })).success, true);
  for (const args of [{ unit: 'invalid' }, { unit: 'day', count: 0 }, { unit: 'day', offset: 0.5 }, { unit: 'day', sql: 'SELECT 1' }]) {
    assert.equal((await registry.executeTool('resolve_date_range', args)).success, false);
  }
  assert.equal((await registry.executeTool('resolve_date_range', { unit: 'day', timezone: 'invalid' })).success, false);
  const staged = require('../src/backend/agent/harness/staged_tools');
  assert.equal(staged.select(registry.listTools()).some(t => t.name === 'resolve_date_range'), true);
});
