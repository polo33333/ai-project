'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryService } = require('../src/backend/memory');
const bridge = require('../src/backend/automation/conversation_memory');

test('a completed workflow is logged as a turn with its rows, so follow-ups read the same result', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ Thang: `2026-${String(i % 12 + 1).padStart(2, '0')}`, SanLuong: i * 10 }));
  const run = { id: 'run-turn', ownerId: 'owner', conversationId: 'conversation', status: 'SUCCEEDED', templateId: 'reports/output',
    updatedAt: new Date().toISOString(), input: {}, definition: { bindings: { query: { dbSourceId: 'db-one', tables: ['dbo.Output'] } } } };
  const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
  assert.equal(bridge.persist(run, { name: 'Sản lượng', inputs: { months: 3 }, result: { rows }, artifacts: [] }, memory).persisted, true);
  const [turn] = memory.getSession('conversation', false, 'owner').turns;
  assert.deepEqual(turn.workflow, { runId: 'run-turn', templateId: 'reports/output', name: 'Sản lượng', field: 'rows' });
  assert.equal(turn.dbSourceId, 'db-one');
  assert.deepEqual(turn.result.columns, ['Thang', 'SanLuong']);
  assert.equal(turn.result.rowCount, 25);
  assert.equal(turn.result.preview.length, 20);
  assert.deepEqual(turn.result.preview[2], ['2026-03', 20]);
});
