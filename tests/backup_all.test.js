'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify, restoreCurrent, importPackage } = require('../scripts/backup_all');

test('backup package verifies checksums and rejects tampering', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-backup-test-'));
  try {
    const files = ['postgres/app.dump', 'qdrant/schema.snapshot', 'qdrant/documents.snapshot'];
    const components = [];
    for (const relativePath of files) {
      const file = path.join(base, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, relativePath);
      components.push({ relativePath, bytes: Buffer.byteLength(relativePath), sha256: crypto.createHash('sha256').update(relativePath).digest('hex') });
    }
    await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify({ version: 1, status: 'complete', collections: ['schema', 'documents'], components }));
    await verify(base);
    await fs.writeFile(path.join(base, 'qdrant', 'schema.snapshot'), 'tampered');
    await assert.rejects(verify(base), /checksum/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('backup package rejects traversal entries', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-backup-test-'));
  try {
    await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify({ version: 1, status: 'complete', collections: ['schema', 'documents'], components: [{ relativePath: '../outside', bytes: 0, sha256: 'x' }] }));
    await assert.rejects(verify(base), /Unsafe/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('safety backup records absent Qdrant collections but cannot be restored', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-backup-test-'));
  try {
    const relativePath = 'postgres/app.dump';
    await fs.mkdir(path.join(base, 'postgres'));
    await fs.writeFile(path.join(base, relativePath), relativePath);
    const manifest = { version: 1, status: 'complete', collections: ['schema', 'documents'], absentCollections: ['schema', 'documents'], components: [{ relativePath, bytes: Buffer.byteLength(relativePath), sha256: crypto.createHash('sha256').update(relativePath).digest('hex') }] };
    await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify(manifest));
    await verify(base);
    await assert.rejects(restoreCurrent(base, { dryRun: true }), /missing Qdrant collections/);
    delete manifest.absentCollections;
    await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(verify(base), /lacks required storage components/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('restore-current preview targets configured live database and collections', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-backup-test-'));
  const previous = Object.fromEntries(['APP_STORAGE_BACKEND', 'APP_PG_DATABASE', 'QDRANT_COLLECTION', 'QDRANT_DOCUMENT_COLLECTION'].map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { APP_STORAGE_BACKEND: 'postgres', APP_PG_DATABASE: 'knowledgehub', QDRANT_COLLECTION: 'schema', QDRANT_DOCUMENT_COLLECTION: 'documents' });
    const components = [];
    for (const relativePath of ['postgres/app.dump', 'qdrant/schema.snapshot', 'qdrant/documents.snapshot']) {
      const file = path.join(base, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, relativePath);
      components.push({ relativePath, bytes: Buffer.byteLength(relativePath), sha256: crypto.createHash('sha256').update(relativePath).digest('hex') });
    }
    await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify({ version: 1, status: 'complete', backupId: 'storage-2026-09-23T10-00-00-000Z-deadbeef', collections: ['schema', 'documents'], components }));
    const plan = await restoreCurrent(base, { dryRun: true });
    assert.equal(plan.database, 'knowledgehub');
    assert.equal(plan.overwriteCurrent, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('three-collection backup restores workflow vectors and rejects missing or duplicate collections', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-backup-test-'));
  const keys = ['APP_STORAGE_BACKEND', 'QDRANT_COLLECTION', 'QDRANT_DOCUMENT_COLLECTION', 'CHAT_ROUTING_RETRIEVAL_COLLECTION'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { APP_STORAGE_BACKEND: 'postgres', QDRANT_COLLECTION: 'schema', QDRANT_DOCUMENT_COLLECTION: 'documents', CHAT_ROUTING_RETRIEVAL_COLLECTION: 'workflow_routing_v1' });
    const components = [];
    for (const relativePath of ['postgres/app.dump', 'qdrant/schema.snapshot', 'qdrant/documents.snapshot', 'qdrant/workflow_routing_v1.snapshot']) {
      const file = path.join(base, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, relativePath);
      components.push({ relativePath, bytes: Buffer.byteLength(relativePath), sha256: crypto.createHash('sha256').update(relativePath).digest('hex') });
    }
    const manifest = { version: 1, status: 'complete', collections: ['schema', 'documents', 'workflow_routing_v1'], components };
    const save = () => fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify(manifest));
    await save();
    const live = await restoreCurrent(base, { dryRun: true });
    assert.equal(live.workflowRoutingRestored, true);
    assert.deepEqual(live.collections, manifest.collections);
    const imported = await importPackage(base, 'knowledgehub_restore_test', { dryRun: true });
    assert.equal(imported.configuration.CHAT_ROUTING_RETRIEVAL_COLLECTION, 'knowledgehub_restore_test_workflow_routing_v1');
    manifest.components = components.slice(0, 3); await save();
    await assert.rejects(verify(base), /lacks required/);
    manifest.collections = ['schema', 'documents', 'documents']; await save();
    await assert.rejects(verify(base), /Invalid collection/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(base, { recursive: true, force: true });
  }
});
