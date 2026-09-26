'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { sources } = require('../../src/backend/storage/postgres/catalog');
const { sha256 } = require('../../src/backend/storage/postgres/crypto');
const { canonical, buildModel } = require('./model');
const automationTransfer = require('../../src/backend/automation/transfer');

async function inventory(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlink in data directory; snapshot refused.');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(file);
        entries.push({ path: path.relative(root, file).split(path.sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  await visit(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function loadDocuments(root) {
  const documents = new Map();
  for (const { file } of sources) {
    try { documents.set(file, JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot parse source: ${file}`); }
  }
  return documents;
}

async function snapshot(dataDirectory, backupRoot) {
  const source = path.resolve(dataDirectory);
  const destination = path.resolve(backupRoot, `postgres-import-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
  if (destination.startsWith(source + path.sep)) throw new Error('Backup destination must be outside data directory.');
  const before = await inventory(source);
  await fs.mkdir(destination, { recursive: true });
  await fs.cp(source, path.join(destination, 'data'), { recursive: true, errorOnExist: true, force: false });
  const copied = await inventory(path.join(destination, 'data'));
  const after = await inventory(source);
  if (canonical(before) !== canonical(copied) || canonical(before) !== canonical(after)) {
    throw new Error('Data changed during snapshot. Stop application/CLI writers and retry. Incomplete snapshot retained for inspection.');
  }
  const known = new Set([...sources.map(source => source.file), ...Object.keys(automationTransfer.files)]);
  const unknownJson = before.filter(file => file.path.endsWith('.json') && !known.has(file.path) && !file.path.startsWith('backup/')).map(file => file.path);
  const manifest = { version: 1, createdAt: new Date().toISOString(), files: copied, unknownJson, snapshotHash: sha256(canonical(copied)) };
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  return { directory: destination, manifest };
}

async function readSnapshot(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.snapshotHash) throw new Error('Not a PostgreSQL import snapshot.');
  const actual = await inventory(path.join(directory, 'data'));
  if (canonical(manifest.files) !== canonical(actual) || manifest.snapshotHash !== sha256(canonical(actual))) throw new Error('Snapshot checksum mismatch.');
  if (manifest.unknownJson.length) throw new Error(`Unmapped JSON files: ${manifest.unknownJson.join(', ')}`);
  const documents = await loadDocuments(path.join(directory, 'data'));
  const model = buildModel(documents), automationDocuments = {};
  for (const file of Object.keys(automationTransfer.files)) {
    try { automationDocuments[file] = JSON.parse(await fs.readFile(path.join(directory, 'data', file), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  model.automationDocuments = automationTransfer.validateDocuments(automationDocuments);
  return { manifest, model, documents };
}

module.exports = { inventory, loadDocuments, snapshot, readSnapshot };
