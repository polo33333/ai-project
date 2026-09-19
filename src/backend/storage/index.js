'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { loadEnvironment } = require('./postgres/config');
const { createPool } = require('./postgres/pool');
const { PostgresRepository, identity } = require('./postgres/repository');
const { sources } = require('./postgres/catalog');
const { readKey } = require('./postgres/crypto');

const scopes = new AsyncLocalStorage();
const known = new Map(sources.map(source => [source.file, source]));
let pool;
let repository;
let closing = false;
const operations = new Set();
const deferredTasks = new Map();
let deferredTaskChain = Promise.resolve();

const enabled = () => process.env.APP_STORAGE_BACKEND === 'postgres';
function scope() {
  const work = scopes.getStore();
  if (!work || work.closed) throw new Error('PostgreSQL service must run inside an awaited storage operation.');
  return work;
}
function checkFile(file) { if (!known.has(file)) throw new Error(`Unregistered application store: ${file}`); }

function cloneDocuments(documents) {
  const result = new Map();
  for (const [file, value] of documents) {
    const clone = structuredClone(value);
    const source = known.get(file);
    if (source && ['array', 'wrapped'].includes(source.shape)) {
      const originalRecords = source.wrapper ? value[source.wrapper] : value;
      const clonedRecords = source.wrapper ? clone[source.wrapper] : clone;
      originalRecords.forEach((record, index) => {
        if (record[identity]) Object.defineProperty(clonedRecords[index], identity, { value: record[identity], configurable: true });
      });
    }
    result.set(file, clone);
  }
  return result;
}

async function bootstrapStorage({ pool: suppliedPool } = {}) {
  if (!enabled()) return;
  readKey();
  if (pool) return;
  closing = false;
  if (!suppliedPool && (!process.env.APP_PG_RUNTIME_USER || !process.env.APP_PG_RUNTIME_PASSWORD)) throw new Error('PostgreSQL runtime role is not configured.');
  pool = suppliedPool || createPool({ runtime: true });
  repository = new PostgresRepository(pool);
  try { await ready(); } catch (error) { await pool.end(); pool = null; repository = null; throw error; }
}

async function ready() {
  if (!enabled()) return { backend: 'json', ready: true };
  if (!pool || closing) throw Object.assign(new Error('STORAGE_NOT_READY'), { statusCode: 503 });
  const result = await pool.query(`SELECT
    (SELECT count(*) FROM app.schema_migrations WHERE name='003_page_chat_history.sql')::int AS schema_ready,
    (SELECT mode FROM app.storage_state WHERE singleton=true) AS mode,
    EXISTS(SELECT 1 FROM app.accounts) AS has_accounts`);
  if (result.rows[0]?.schema_ready !== 1 || result.rows[0]?.mode !== 'live' || !result.rows[0]?.has_accounts) throw Object.assign(new Error('POSTGRES_SCHEMA_OR_CUTOVER_NOT_READY'), { statusCode: 503 });
  return { backend: 'postgres', ready: true, schema: 3 };
}

async function run(operation, { independent = false, files } = {}) {
  if (!enabled()) return operation();
  if (!independent && scopes.getStore() && !scopes.getStore().closed) return operation();
  if (!repository || closing) throw Object.assign(new Error('STORAGE_NOT_READY'), { statusCode: 503 });
  const execution = (async () => {
    const snapshot = await repository.snapshot(files);
    const work = {
      id: crypto.randomUUID(), documents: snapshot.documents,
      baseline: cloneDocuments(snapshot.documents), dirty: new Set(), jobs: [], closed: false,
      transforms: new Set(), committing: null, allowedFiles: files ? new Set(files) : null,
      afterCommit: new Map()
    };
    const result = await scopes.run(work, async () => {
      try {
        const result = await operation();
        await flush();
        return result;
      } finally { work.closed = true; }
    });
    for (const [key, callback] of work.afterCommit) scheduleDeferredTask(key, callback);
    return result;
  })();
  operations.add(execution);
  try { return await execution; } finally { operations.delete(execution); }
}

function scheduleDeferredTask(key, callback) {
  const existing = deferredTasks.get(key);
  if (existing) clearTimeout(existing.timer);
  const task = { callback };
  task.timer = setTimeout(() => {
    deferredTasks.delete(key);
    deferredTaskChain = deferredTaskChain
      .then(() => run(task.callback, { independent: true }))
      .catch(error => console.error(`[Storage] Deferred task '${key}' failed:`, error.code || error.message || error.name || 'ERROR'));
  }, 100);
  task.timer.unref?.();
  deferredTasks.set(key, task);
}

function afterCommit(key, callback) {
  if (!enabled()) return false;
  const work = scopes.getStore();
  if (!work || work.closed) return false;
  work.afterCommit.set(key, callback);
  return true;
}

async function flush() {
  if (!enabled()) return;
  const work = scope();
  if (work.committing) return work.committing;
  if (!work.dirty.size && !work.jobs.length && !work.receipt) return;
  work.committing = repository.commit(work);
  try {
    await work.committing;
    work.baseline = cloneDocuments(work.documents);
    work.dirty.clear(); work.jobs = []; work.id = crypto.randomUUID();
  } finally { work.committing = null; }
}

function read(file, fallback) {
  checkFile(file);
  const work = scope();
  if (work.allowedFiles && !work.allowedFiles.has(file)) throw new Error(`Store not loaded for this operation: ${file}`);
  if (!work.documents.has(file)) work.documents.set(file, structuredClone(fallback));
  return work.documents.get(file);
}

function write(file, value) {
  checkFile(file);
  const work = scope();
  if (work.allowedFiles && !work.allowedFiles.has(file)) throw new Error(`Store not loaded for this operation: ${file}`);
  if (work.committing) throw new Error('Cannot mutate storage while committing.');
  work.documents.set(file, value); work.dirty.add(file);
  return true;
}

function bind(service, property, file, fallback, transform) {
  Object.defineProperty(service, property, {
    configurable: true, enumerable: true,
    get() {
      const work = scope();
      let value = read(file, fallback);
      if (transform && !work.transforms.has(file)) {
        value = transform(value); work.documents.set(file, value); work.transforms.add(file);
      }
      return value;
    },
    set(value) { scope().documents.set(file, value); }
  });
}

function enqueue(kind, resourceId, payload = {}) {
  const job = { id: crypto.randomUUID(), kind, resourceId, payload };
  scope().jobs.push(job);
  return job.id;
}

function receipt(value) { scope().receipt=value; }

function detach(callback) { return (...args) => scopes.exit(() => callback(...args)); }

async function close() {
  closing = true;
  await Promise.allSettled([...operations]);
  if (pool) await pool.end();
  pool = null; repository = null;
}

async function lease(key, operation, { ttlMs = 120000 } = {}) {
  if (!enabled()) return operation();
  const owner = crypto.randomUUID();
  const acquire = await pool.query(`INSERT INTO app.worker_leases(key, owner, expires_at) VALUES($1,$2,now()+$3*interval '1 millisecond')
    ON CONFLICT(key) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
    WHERE app.worker_leases.expires_at<now() RETURNING owner`, [key, owner, ttlMs]);
  if (!acquire.rowCount) return { skipped: true, reason: 'lease_held' };
  let lost = false;
  const timer = setInterval(detach(() => {
    pool.query("UPDATE app.worker_leases SET expires_at=now()+$3*interval '1 millisecond' WHERE key=$1 AND owner=$2 RETURNING owner", [key,owner,ttlMs])
      .then(result => { if (!result.rowCount) lost = true; }).catch(() => { lost = true; });
  }), Math.max(1000, Math.floor(ttlMs / 3)));
  timer.unref();
  try { const result = await operation(); if (lost) throw new Error('WORKER_LEASE_LOST'); return result; }
  finally { clearInterval(timer); await pool.query('DELETE FROM app.worker_leases WHERE key=$1 AND owner=$2', [key, owner]); }
}

module.exports = { enabled, loadEnvironment, bootstrapStorage, run, flush, read, write, bind, enqueue, receipt, afterCommit, detach, ready, close, lease, getPool: () => pool };
