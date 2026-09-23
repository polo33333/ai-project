'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { docker } = require('./postgres/backup');
const { loadEnvironment, connectionConfig } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');

const root = path.resolve(__dirname, '..');
const collections = () => [...new Set([process.env.QDRANT_COLLECTION || 'database_schema_v2', process.env.QDRANT_DOCUMENT_COLLECTION || 'knowledge_documents_bge_m3_v1'])];
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value) && value !== '.' && value !== '..';
const safePathPart = value => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/:\x00-\x1f]/.test(value);
const digest = async file => {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};
const metadata = async (base, relativePath, extra = {}) => {
  const file = path.join(base, ...relativePath.split('/'));
  return { relativePath, bytes: (await fsp.stat(file)).size, sha256: await digest(file), ...extra };
};
const qdrantUrl = () => new URL(process.env.QDRANT_URL || 'http://127.0.0.1:6333');

function request(url, method = 'GET', { output, input, contentType } = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Unsupported Qdrant protocol.');
  const transport = target.protocol === 'https:' ? https : http;
  const headers = {};
  if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
  if (contentType) headers['Content-Type'] = contentType;
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method, headers, timeout: 120000 }, async res => {
      try {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          throw new Error(`Qdrant ${method} ${target.pathname} failed (HTTP ${res.statusCode}).`);
        }
        if (output) {
          await pipeline(res, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }));
          resolve();
        } else {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.status && body.status !== 'ok') throw new Error('Qdrant operation failed.');
          resolve(body);
        }
      } catch (error) { reject(error); }
    });
    req.on('timeout', () => req.destroy(new Error('Qdrant request timed out.')));
    req.on('error', reject);
    if (input) pipeline(input, req).catch(reject);
    else req.end();
  });
}

async function copyTree(source, target, base, components) {
  if (!fs.existsSync(source)) return;
  await fsp.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) throw new Error('Symlink or special file in library data.');
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(src, dst, base, components);
    else {
      await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
      await fsp.chmod(dst, 0o600);
      components.push(await metadata(base, path.relative(base, dst).split(path.sep).join('/'), { kind: 'file' }));
    }
  }
}

async function verify(directory) {
  const base = path.resolve(directory);
  if (fs.existsSync(path.join(base, 'INCOMPLETE'))) throw new Error('Incomplete backup package.');
  if ((await fsp.lstat(base)).isSymbolicLink()) throw new Error('Symlink backup directory.');
  if ((await fsp.lstat(path.join(base, 'manifest.json'))).isSymbolicLink()) throw new Error('Symlink manifest.');
  const manifest = JSON.parse(await fsp.readFile(path.join(base, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.status !== 'complete' || !Array.isArray(manifest.components)) throw new Error('Incomplete or unsupported backup package.');
  const names = new Set();
  for (const item of manifest.components) {
    const parts = item.relativePath?.split('/');
    if (!parts?.length || parts.some(p => !safePathPart(p)) || names.has(item.relativePath)) throw new Error('Unsafe or duplicate backup path.');
    names.add(item.relativePath);
    let parent = base;
    for (const part of parts) {
      parent = path.join(parent, part);
      const stat = await fsp.lstat(parent);
      if (stat.isSymbolicLink()) throw new Error('Symlink in backup package.');
    }
    const stat = await fsp.stat(parent);
    if (!stat.isFile() || stat.size !== item.bytes || await digest(parent) !== item.sha256) throw new Error(`Backup checksum failed: ${item.relativePath}`);
  }
  const required = collectionsFromManifest(manifest);
  if (!names.has('postgres/app.dump') || required.some(c => !names.has(`qdrant/${c}.snapshot`))) throw new Error('Backup lacks required storage components.');
  return manifest;
}

function collectionsFromManifest(manifest) {
  if (!Array.isArray(manifest.collections) || manifest.collections.length !== 2 || manifest.collections.some(c => !safeName(c))) throw new Error('Invalid collection list.');
  return manifest.collections;
}

async function backup({ coordinated = false } = {}) {
  if (process.env.APP_STORAGE_BACKEND !== 'postgres') throw new Error('APP_STORAGE_BACKEND=postgres is required.');
  if (!coordinated && process.env.BACKUP_APP_STOPPED !== '1') throw new Error('Stop the app and all writers, then set BACKUP_APP_STOPPED=1.');
  const names = collections();
  if (names.length !== 2 || names.some(c => !safeName(c))) throw new Error('Two distinct, safe Qdrant collection names are required.');
  const backupRoot = path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(root, 'backups'));
  await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backupId = `storage-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const base = path.join(backupRoot, `${backupId}.partial`);
  await fsp.mkdir(base, { mode: 0o700 });
  const components = [];
  try {
    await fsp.mkdir(path.join(base, 'postgres'));
    await fsp.mkdir(path.join(base, 'qdrant'));
    await docker('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema=app'], { output: path.join(base, 'postgres', 'app.dump') });
    components.push(await metadata(base, 'postgres/app.dump', { kind: 'postgres' }));
    const endpoint = qdrantUrl();
    const qdrantVersion = (await request(new URL('/', endpoint))).version;
    for (const name of names) {
      const route = `/collections/${encodeURIComponent(name)}`;
      const info = (await request(new URL(route, endpoint))).result;
      if (!info) throw new Error(`Qdrant collection missing: ${name}`);
      const created = (await request(new URL(`${route}/snapshots?wait=true`, endpoint), 'POST')).result;
      if (!safeName(created?.name)) throw new Error('Qdrant returned an unsafe snapshot name.');
      const relativePath = `qdrant/${name}.snapshot`;
      await request(new URL(`${route}/snapshots/${encodeURIComponent(created.name)}`, endpoint), 'GET', { output: path.join(base, relativePath) });
      components.push(await metadata(base, relativePath, { kind: 'qdrant', sourceName: name, pointsCount: info.points_count, config: info.config }));
    }
    const dataDir = path.resolve(process.env.KNOWLEDGEHUB_DATA_DIR || path.join(root, 'data'));
    for (const folder of ['library_files', 'library_content']) await copyTree(path.join(dataDir, folder), path.join(base, 'files', folder), base, components);
    const manifest = { version: 1, backupId, status: 'complete', createdAt: new Date().toISOString(), storageBackend: 'postgres', consistencyMode: coordinated ? 'http-writers-paused' : 'application-stopped', postgresDatabase: connectionConfig().database, qdrantVersion, collections: names, embeddingModel: process.env.EMBEDDING_MODEL || 'bge-m3', encryptionKeyRequired: true, components };
    await fsp.writeFile(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    await verify(base);
    const destination = path.join(backupRoot, backupId);
    await fsp.rename(base, destination);
    return { backup: destination, backupId, components: components.length };
  } catch (error) {
    await fsp.writeFile(path.join(base, 'INCOMPLETE'), 'Backup failed. Do not import this directory.\n', { mode: 0o600 }).catch(() => {});
    throw error;
  }
}

async function importPackage(directory, target, { dryRun = false } = {}) {
  const base = path.resolve(directory);
  const manifest = await verify(base);
  if (!/^knowledgehub_restore_[a-z0-9_]+$/.test(target || '')) throw new Error('Target must be a NEW knowledgehub_restore_* database.');
  const targetCollections = collectionsFromManifest(manifest).map(name => `${target}_${name}`);
  if (targetCollections.some(name => !safeName(name))) throw new Error('Unsafe target collection name.');
  const plan = { package: manifest.backupId, database: target, collections: targetCollections, files: manifest.components.filter(c => c.kind === 'file').length };
  if (dryRun) return { dryRun: true, ...plan };
  const endpoint = qdrantUrl();
  const targetVersion = (await request(new URL('/', endpoint))).version;
  if (manifest.qdrantVersion && targetVersion && manifest.qdrantVersion.split('.').slice(0, 2).join('.') !== targetVersion.split('.').slice(0, 2).join('.')) {
    throw new Error(`Qdrant version mismatch: backup ${manifest.qdrantVersion}, target ${targetVersion}.`);
  }
  for (const name of targetCollections) {
    try { await request(new URL(`/collections/${encodeURIComponent(name)}`, endpoint)); throw new Error(`Target collection already exists: ${name}`); }
    catch (error) { if (!/HTTP 404/.test(error.message)) throw error; }
  }
  const admin = createPool({ bootstrap: true });
  try { await admin.query(`CREATE DATABASE "${target}" OWNER knowledgehub_migrator TEMPLATE template0`); }
  finally { await admin.end(); }
  const report = { ...plan, readyForCutover: false, steps: [] };
  try {
    await docker('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { input: path.join(base, 'postgres', 'app.dump'), database: target });
    const restored = createPool({ database: target });
    try {
      const tables = await restored.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'app' AND table_type = 'BASE TABLE'");
      if (!tables.rows[0]?.count) throw new Error('Restored PostgreSQL schema app has no tables.');
      report.postgresTables = tables.rows[0].count;
    } finally { await restored.end(); }
    report.steps.push('postgres-restored');
    for (let i = 0; i < targetCollections.length; i++) {
      const name = targetCollections[i];
      const source = manifest.collections[i];
      const file = path.join(base, 'qdrant', `${source}.snapshot`);
      const boundary = `kh-${crypto.randomBytes(12).toString('hex')}`;
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="snapshot"; filename="${source}.snapshot"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      const { Readable } = require('node:stream');
      const body = Readable.from((async function* () { yield prefix; yield* fs.createReadStream(file); yield suffix; })());
      await request(new URL(`/collections/${encodeURIComponent(name)}/snapshots/upload?wait=true`, endpoint), 'POST', { input: body, contentType: `multipart/form-data; boundary=${boundary}` });
      const info = (await request(new URL(`/collections/${encodeURIComponent(name)}`, endpoint))).result;
      const expected = manifest.components.find(c => c.kind === 'qdrant' && c.sourceName === source);
      if (info?.points_count !== expected.pointsCount) throw new Error(`Point count mismatch: ${name}`);
      report.steps.push(`qdrant-restored:${name}`);
    }
    // File assets are staged beside the new database. Operators copy them to the target data directory at cutover.
    const staging = path.join(base, 'files');
    report.libraryFiles = fs.existsSync(staging) ? staging : null;
    report.readyForCutover = true;
    return report;
  } catch (error) {
    report.error = error.code || error.message;
    throw error;
  } finally {
    const reportFile = path.join(path.dirname(base), `${manifest.backupId}-${target}-import-report.json`);
    await fsp.writeFile(reportFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 }).catch(() => {});
  }
}

async function main() {
  loadEnvironment(root);
  const [command, packagePath, target, option] = process.argv.slice(2);
  let result;
  if (command === 'backup') result = await backup();
  else if (command === 'verify' && packagePath) result = { verified: true, backupId: (await verify(packagePath)).backupId };
  else if (command === 'import' && packagePath && target) result = await importPackage(packagePath, target, { dryRun: option === '--dry-run' });
  else throw new Error('Usage: backup_all.js backup | verify <package> | import <package> <new-knowledgehub_restore_database> [--dry-run]');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.code ? `Backup operation failed (${error.code})` : error.message); process.exitCode = 1; });
module.exports = { backup, verify, importPackage, safeName };
