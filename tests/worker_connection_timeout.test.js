'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { AutomationRuntime } = require('../src/backend/automation/runtime');
const { describe } = require('../src/backend/storage/postgres/worker_failure');
test('slow automation discovery is single-flight and next poll recovers after timeout', async () => {
  let reject, calls = 0;
  const repository = { list: () => { calls++; return new Promise((resolve, fail) => { reject = fail; }); } };
  const runtime = new AutomationRuntime(repository, {}, { enabled: () => true });
  const first = runtime.tick(), second = runtime.tick();
  assert.equal(first, second);
  assert.equal(calls, 1);
  reject(new Error('Connection terminated due to connection timeout'));
  await assert.rejects(first, /connection timeout/);
  repository.list = async () => { calls++; return []; };
  await runtime.tick();
  assert.equal(calls, 2);
});
test('stop awaits a slow poll and prevents launching jobs after shutdown', async () => {
  let resolve;
  const runtime = new AutomationRuntime({ list: () => new Promise(done => { resolve = done; }) }, {}, { enabled: () => true });
  let processed = false;
  runtime.process = async () => { processed = true; };
  const tick = runtime.tick(), stop = runtime.stop();
  resolve([{ id: 'test-run' }]);
  await Promise.all([tick, stop]);
  assert.equal(processed, false);
});
test('connection diagnostics expose pool pressure without error text or credentials', () => {
  const value = describe(new Error('Connection terminated due to connection timeout'), { totalCount: 5, idleCount: 0, waitingCount: 7, options: { max: 5, password: 'private' } });
  assert.equal(value.code, 'DB_CONNECTION_TIMEOUT');
  assert.equal(value.pool.waiting, 7);
  assert.ok(!JSON.stringify(value).includes('private'));
  assert.equal(describe(Object.assign(new Error('sensitive query'), { code: 'ECONNRESET' })).code, 'ECONNRESET');
});
