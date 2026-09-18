'use strict';

const crypto = require('node:crypto');
const { loadEnvironment } = require('../../src/backend/storage/postgres/config');
const { createPool } = require('../../src/backend/storage/postgres/pool');
const { migrate } = require('../../src/backend/storage/postgres/migrate');
const { readSnapshot } = require('./snapshot');
const { importSnapshot, verifySnapshot } = require('./transfer');

async function main() {
  loadEnvironment();
  if (!process.argv[2]) throw new Error('Usage: rehearse.js <snapshot-directory>');
  const snapshot = await readSnapshot(process.argv[2]);
  const database = 'knowledgehub_rehearsal_' + crypto.randomBytes(8).toString('hex');
  const admin = createPool({ bootstrap: true });
  let pool;
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    pool = createPool({ bootstrap: true, database });
    await migrate(pool);
    const imported = await importSnapshot(pool, snapshot);
    const verified = await verifySnapshot(pool, snapshot);
    const repeated = await importSnapshot(pool, snapshot);
    console.log(JSON.stringify({ database, imported: imported.ok, verified: verified.ok, idempotent: repeated.alreadyImported, tables: verified.tables }));
  } finally {
    if (pool) await pool.end();
    // Only the unique database created by this invocation can be removed.
    if (!/^knowledgehub_rehearsal_[a-f0-9]{16}$/.test(database)) throw new Error('Invalid rehearsal database');
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
}
main().catch(error => { console.error(error.code ? `Rehearsal failed (${error.code})` : error.message); process.exitCode = 1; });
