'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { createStream, unpack } = require('../src/backend/services/backup_bundle');

test('single backup file round trips PostgreSQL and Qdrant files', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kh-bundle-test-'));
  try {
    const source = path.join(temp, 'source'); const restored = path.join(temp, 'restored');
    await fs.mkdir(source); await fs.mkdir(restored);
    const components = [];
    for (const relativePath of ['postgres/app.dump', 'qdrant/schema.snapshot', 'qdrant/docs.snapshot', 'files/library_files/example.txt']) {
      const value = Buffer.from(relativePath);
      const file = path.join(source, relativePath);
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value);
      components.push({ relativePath, bytes: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') });
    }
    const id = 'storage-2026-09-23T10-00-00-000Z-deadbeef';
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ version: 1, status: 'complete', backupId: id, collections: ['schema', 'docs'], components }));
    const { stream } = await createStream(source);
    const bundle = path.join(temp, 'saved.khbackup');
    await pipeline(stream, createWriteStream(bundle));
    const manifest = await unpack(bundle, restored);
    assert.equal(manifest.backupId, id);
    assert.equal((await fs.readFile(path.join(restored, 'files/library_files/example.txt'), 'utf8')), 'files/library_files/example.txt');
    await fs.appendFile(bundle, 'tamper');
    await assert.rejects(unpack(bundle, path.join(temp, 'tampered')), /Unexpected backup file contents/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
