'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settle = () => new Promise(resolve => setImmediate(resolve));

test('a failed watcher is logged once with its message and restarts until it recovers', async t => {
  const service = require('../src/backend/knowledge/services/watchfolder_service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchfolder-restart-'));
  const previous = { folders: service.folders, logs: service.logs };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => { await service.stop(); service.folders = previous.folders; service.logs = previous.logs; fs.rmSync(dir, { recursive: true, force: true }); });
  service.folders = [{ id: 'restart-folder', path: dir, filters: ['.pdf'], status: 'Active', runtimeStatus: 'Starting' }];
  service.logs = [];
  const folder = () => service.folders[0];

  await service.startFolder(folder(), false);
  assert.equal(folder().runtimeStatus, 'Watching');

  service.handleWatcherError('restart-folder', new Error('EPERM: operation not permitted, watch'));
  await settle();
  assert.equal(folder().runtimeStatus, 'Error');
  assert.equal(folder().error, 'EPERM: operation not permitted, watch');
  assert.deepEqual(service.logs.map(log => [log.event, log.error]), [['Lỗi watcher', 'EPERM: operation not permitted, watch']]);

  // The directory is gone while retrying: the message is refreshed, nothing more is logged.
  fs.renameSync(dir, `${dir}-moved`);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(folder().runtimeStatus, 'Error');
  assert.match(folder().error, /không tồn tại/);
  assert.equal(service.logs.length, 1);
  assert.equal(service.restarts.get('restart-folder').attempt, 2);

  fs.renameSync(`${dir}-moved`, dir);
  t.mock.timers.tick(15000);
  await settle();
  assert.equal(folder().runtimeStatus, 'Watching');
  assert.equal(folder().error, null);
  assert.equal(service.logs[0].event, 'Watcher chạy lại');
  assert.equal(service.restarts.has('restart-folder'), false);
});

test('pausing a failed folder cancels its pending restart', async t => {
  const service = require('../src/backend/knowledge/services/watchfolder_service');
  const previous = { folders: service.folders, logs: service.logs };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(async () => { await service.stop(); service.folders = previous.folders; service.logs = previous.logs; });
  service.folders = [{ id: 'paused-folder', path: path.join(os.tmpdir(), 'watchfolder-missing-dir'), filters: ['.pdf'], status: 'Active', runtimeStatus: 'Starting' }];
  service.logs = [];

  await service.startFolder(service.folders[0], false);
  assert.equal(service.folders[0].runtimeStatus, 'Error');
  assert.equal(service.restarts.has('paused-folder'), true);

  await service.toggleFolderStatus('paused-folder');
  assert.equal(service.folders[0].runtimeStatus, 'Paused');
  assert.equal(service.restarts.has('paused-folder'), false);
});
