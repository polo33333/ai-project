'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { backup, verify, importPackage } = require('../../../scripts/backup_all');
const { createStream, unpack, receiveUpload } = require('./backup_bundle');
const backupGate = require('./backup_gate');
const { loadEnvironment } = require('../storage/postgres/config');

loadEnvironment();
let job = null;
const root = () => path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(__dirname, '../../../backups'));
const available = () => process.env.APP_STORAGE_BACKEND === 'postgres';
const idPattern = /^storage-[0-9TZ-]+-[a-f0-9]{8}$/;

async function packageDirectory(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw Object.assign(new Error('Mã gói backup không hợp lệ.'), { statusCode: 400 });
  const directory = path.join(root(), id);
  if (!(await fs.stat(directory).catch(() => null))?.isDirectory()) throw Object.assign(new Error('Không tìm thấy gói backup.'), { statusCode: 404 });
  return directory;
}

async function list() {
  const directory = root();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    const manifest = await fs.readFile(path.join(directory, entry.name, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.version !== 1 || manifest?.backupId !== entry.name) continue;
    packages.push({ id: entry.name, createdAt: manifest.createdAt, components: manifest.components?.length || 0, collections: manifest.collections || [] });
  }
  packages.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { available: available(), packages };
}

function status() { return { available: available(), job }; }

async function download(id) { return createStream(await packageDirectory(id)); }

async function upload(req) {
  if (job?.state === 'running') throw Object.assign(new Error('Đang có tác vụ khác chạy.'), { statusCode: 409 });
  await fs.mkdir(root(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(8).toString('hex');
  const uploaded = path.join(root(), `.upload-${token}.khbackup`);
  const staging = path.join(root(), `.upload-${token}.partial`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    await receiveUpload(req, uploaded);
    const manifest = await unpack(uploaded, staging);
    const destination = path.join(root(), manifest.backupId);
    await fs.rename(staging, destination);
    return { uploaded: true, id: manifest.backupId, components: manifest.components.length };
  } finally {
    await fs.rm(uploaded, { force: true }).catch(() => {});
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function start(action, input = {}) {
  if (job?.state === 'running') throw Object.assign(new Error('Đang có tác vụ backup/import chạy.'), { statusCode: 409 });
  if (!available()) throw Object.assign(new Error('Cần APP_STORAGE_BACKEND=postgres.'), { statusCode: 409 });
  if (!['backup', 'verify', 'import'].includes(action)) throw Object.assign(new Error('Thao tác không hợp lệ.'), { statusCode: 400 });
  if (action !== 'backup' && (typeof input.id !== 'string' || !idPattern.test(input.id))) throw Object.assign(new Error('Chọn gói backup hợp lệ.'), { statusCode: 400 });
  if (action === 'import' && !/^knowledgehub_restore_[a-z0-9_]+$/.test(input.target || '')) throw Object.assign(new Error('Tên database đích phải bắt đầu bằng knowledgehub_restore_.'), { statusCode: 400 });
  job = { action, state: 'running', startedAt: new Date().toISOString(), id: input.id || null, target: input.target || null };
  const current = job;
  setImmediate(async () => {
    try {
      const directory = action === 'backup' ? null : await packageDirectory(input.id);
      current.result = action === 'backup' ? await backupGate.withPausedWrites(() => backup({ coordinated: true })) : action === 'verify' ? { verified: true, backupId: (await verify(directory)).backupId } : await importPackage(directory, input.target, { dryRun: input.dryRun === true });
      current.state = 'complete';
    } catch (error) {
      current.state = 'failed';
      current.error = error.code || error.message;
    } finally { current.finishedAt = new Date().toISOString(); }
  });
  return { accepted: true, job: current };
}

module.exports = { list, status, start, download, upload };
