'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/frontend/admin-client/js/modules/watchfolder.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

test('background polling never shows a loading state and leaves unchanged tables alone', async () => {
  const writes = { 'watchfolder-tbody': [], 'watchfolder-logs-tbody': [] };
  const element = id => ({ set innerHTML(value) { writes[id].push(value); }, get innerHTML() { return writes[id].at(-1) || ''; } });
  const elements = { 'watchfolder-tbody': element('watchfolder-tbody'), 'watchfolder-logs-tbody': element('watchfolder-logs-tbody'), 'view-watchfolder': { style: { display: 'block' } } };
  let folders = [{ id: 'f1', path: 'D:\\docs', filters: ['.pdf'], status: 'Active', runtimeStatus: 'Watching', scannedFiles: 2 }];
  let failing = false;
  const toasts = [];
  let poll;
  const context = vm.createContext({
    document: { hidden: false, getElementById: id => elements[id] || null },
    setInterval: callback => { poll = callback; },
    showToast: message => toasts.push(message),
    fetch: async url => {
      if (failing) throw new Error('offline');
      return { ok: true, json: async () => structuredClone(url.endsWith('/logs') ? [] : folders) };
    }
  });
  context.window = context;
  vm.runInContext(source, context);

  poll(); await settle();
  assert.equal(writes['watchfolder-tbody'].length, 1);
  assert.doesNotMatch(writes['watchfolder-tbody'][0], /Đang tải/);

  poll(); await settle();
  assert.equal(writes['watchfolder-tbody'].length, 1, 'identical data is not re-rendered');

  failing = true;
  poll(); await settle();
  assert.equal(writes['watchfolder-tbody'].length, 1, 'a failed poll keeps the current table');
  assert.deepEqual(toasts, []);

  failing = false;
  folders = [{ ...folders[0], runtimeStatus: 'Error', error: 'EPERM' }];
  poll(); await settle();
  assert.equal(writes['watchfolder-tbody'].length, 2);
  assert.match(writes['watchfolder-tbody'][1], /Lỗi watcher/);
});
