'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('watchfolder retries conflict with fresh independent scope and respects a paused folder', async t => {
  const storage = require('../src/backend/storage');
  const service = require('../src/backend/knowledge_core/services/watchfolder_service');
  t.mock.method(storage, 'enabled', () => true);
  t.mock.method(storage, 'lease', async (_, operation) => operation());
  let calls = 0, processed = 0;
  t.mock.method(service, '_processFile', async () => { processed++; });
  t.mock.method(storage, 'run', async (operation, options) => {
    assert.equal(options.independent, true); calls++;
    if (calls === 1) throw Object.assign(new Error('conflict'), { code: 'DATA_CONFLICT' });
    return operation();
  });
  const previous = service.folders;
  try {
    service.folders = [{ id: 'test-folder', status: 'Active' }];
    await service.processFile({ id: 'test-folder' }, 'test-file.txt');
    assert.equal(calls, 2); assert.equal(processed, 1);
    service.folders[0].status = 'Paused';
    await service.processFile({ id: 'test-folder' }, 'test-file.txt');
    assert.equal(processed, 1);
    t.mock.method(storage, 'run', async () => { calls++; throw Object.assign(new Error('conflict'), { code: 'DATA_CONFLICT' }); });
    const before = calls;
    await assert.rejects(service.processFile({ id: 'test-folder' }, 'test-file.txt'), { code: 'DATA_CONFLICT' });
    assert.equal(calls - before, 3);
  } finally { service.folders = previous; }
});
