'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verify } = require('../scripts/backup_all');

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
