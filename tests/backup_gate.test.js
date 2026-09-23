'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../src/backend/services/backup_gate');

test('online backup pauses workers, blocks normal traffic, and resumes on failure', async () => {
  const calls = [];
  gate.configure({ pause: async () => calls.push('pause'), resume: async () => calls.push('resume') });
  let release;
  const running = gate.withPausedWrites(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const response = { writeHead(status) { this.status = status; }, end() {} };
  assert.equal(gate.enter({ url: '/api/library' }, response), false);
  assert.equal(response.status, 503);
  release(); await running;
  assert.deepEqual(calls, ['pause', 'resume']);
  await assert.rejects(gate.withPausedWrites(() => { throw new Error('failed'); }), /failed/);
  assert.deepEqual(calls, ['pause', 'resume', 'pause', 'resume']);
});
