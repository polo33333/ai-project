'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('preflight includes phase 1 domain stores and verifies their records', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'automation-transfer-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'data'); await fs.mkdir(source);
  const settings = { id: '_settings', revision: 1, enabled: true, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(source, 'workflow_catalog.json'), JSON.stringify({ _settings: settings }));
  await fs.writeFile(path.join(source, 'automation_runs.json'), '{}');
  const { snapshot, readSnapshot } = require('../scripts/postgres/snapshot');
  const copied = await snapshot(source, path.join(base, 'backups')); assert.deepEqual(copied.manifest.unknownJson, []);
  const loaded = await readSnapshot(copied.directory); assert.deepEqual(loaded.model.automationDocuments['workflow_catalog.json']._settings, settings);
  const { validateDocuments } = require('../src/backend/automation/transfer');
  assert.throws(() => validateDocuments({ 'automation_runs.json': { run: { id: 'run', revision: 1, updatedAt: settings.updatedAt } } }), /owner\/status/);
});
