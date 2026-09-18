'use strict';

const crypto = require('node:crypto');
const { tables } = require('../../src/backend/storage/postgres/catalog');
const { transaction } = require('../../src/backend/storage/postgres/pool');
const { protect, sha256 } = require('../../src/backend/storage/postgres/crypto');
const { encode, decode } = require('../../src/backend/storage/postgres/codec');
const { canonical, reconstruct } = require('./model');

async function readModel(client) {
  const hasRuntime = (await client.query("SELECT to_regclass('app.domain_stores') AS name")).rows[0].name;
  const files = hasRuntime ? (await client.query('SELECT file, root FROM app.domain_stores ORDER BY file')).rows.map(row => ({
    ...require('../../src/backend/storage/postgres/catalog').sources.find(source => source.file === row.file), root: row.root
  })) : (await client.query('SELECT metadata FROM app.import_files ORDER BY file')).rows.map(row => row.metadata);
  for (const file of files) file.root = protect(file.root, `file/${file.file}`, true);
  const rows = {};
  for (const table of tables) {
    rows[table] = (await client.query(`SELECT * FROM app.${table} ORDER BY ordinal, id`)).rows;
    for (const row of rows[table]) row.payload = decode(table, row.id, row.payload);
  }
  return { files, rows };
}

async function verifyClient(client, expected) {
  const stored = await readModel(client);
  const restored = reconstruct(stored);
  const source = reconstruct(expected);
  const checks = [];
  for (const file of expected.files) {
    const actual = restored.get(file.file);
    const ok = actual !== undefined && canonical(actual) === canonical(source.get(file.file));
    checks.push({ file: file.file, records: file.count, checksum: actual === undefined ? null : sha256(canonical(actual)), ok });
  }
  if (stored.files.length !== expected.files.length || checks.some(check => !check.ok)) throw new Error('PostgreSQL round-trip verification failed.');
  for (const table of tables) {
    const wanted = expected.rows[table];
    const actual = stored.rows[table];
    if (wanted.length !== actual.length) throw new Error(`Row count mismatch: ${table}`);
    const byId = new Map(actual.map(row => [row.id, row]));
    for (const row of wanted) {
      const found = byId.get(row.id);
      if (!found) throw new Error(`Missing row in ${table}`);
      for (const [key, value] of Object.entries(row)) {
        const got = found[key] instanceof Date ? found[key].toISOString() : found[key];
        if (canonical(got) !== canonical(value)) throw new Error(`Row mismatch: ${table}.${key}`);
      }
    }
  }
  return { ok: true, files: checks, tables: Object.fromEntries(tables.map(table => [table, stored.rows[table].length])) };
}

async function importSnapshot(pool, snapshot) {
  const { model, manifest } = snapshot;
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('knowledgehub-data-import'))");
    const state = (await client.query('SELECT mode FROM app.storage_state WHERE singleton = true FOR UPDATE')).rows[0];
    if (!state || state.mode !== 'staging') throw new Error('Import prohibited: database is live.');
    const existing = await client.query('SELECT snapshot_hash FROM app.import_batches');
    if (existing.rows.length) {
      if (existing.rows.length !== 1 || existing.rows[0].snapshot_hash !== manifest.snapshotHash) throw new Error('Database already contains another snapshot. Import into an empty database; existing data will not be overwritten.');
      return { ...(await verifyClient(client, model)), alreadyImported: true };
    }
    for (const table of tables) if ((await client.query(`SELECT 1 FROM app.${table} LIMIT 1`)).rowCount) throw new Error(`Target is not empty: ${table}`);
    const batchId = crypto.randomUUID();
    await client.query('INSERT INTO app.import_batches(id, snapshot_hash, report) VALUES ($1,$2,$3)', [batchId, manifest.snapshotHash, JSON.stringify({ warnings: model.warnings })]);
    for (const file of model.files) {
      await client.query('INSERT INTO app.import_files(file, batch_id, metadata) VALUES ($1,$2,$3)', [file.file, batchId, JSON.stringify({ ...file, root: protect(file.root, `file/${file.file}`) })]);
      const hasRuntime = (await client.query("SELECT to_regclass('app.domain_stores') AS name")).rows[0].name;
      if (hasRuntime) await client.query('INSERT INTO app.domain_stores(file, root) VALUES($1,$2)', [file.file, JSON.stringify(protect(file.root, `file/${file.file}`))]);
    }
    for (const table of tables) {
      for (const row of model.rows[table]) {
        const record = { ...row, payload: encode(table, row.id, row.payload) };
        const keys = Object.keys(record);
        const values = keys.map(key => ['payload', 'child_fields'].includes(key) ? JSON.stringify(record[key]) : record[key]);
        await client.query(`INSERT INTO app.${table} (${keys.join(',')}) VALUES (${keys.map((_,i) => `$${i+1}`).join(',')})`, values);
      }
    }
    // Verification is inside the SAME transaction: failure rolls back all domains.
    return { ...(await verifyClient(client, model)), alreadyImported: false, warnings: model.warnings };
  });
}

async function verifySnapshot(pool, snapshot) {
  return transaction(pool, client => verifyClient(client, snapshot.model), { readOnly: true });
}

module.exports = { encode, decode, readModel, verifyClient, importSnapshot, verifySnapshot };
