'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { transaction } = require('./pool');
const { sha256 } = require('./crypto');
const directory = path.resolve(__dirname, '../../../../migrations/postgres');

async function migrate(pool) {
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('knowledgehub-schema-migrations'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS app');
    await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map((await client.query('SELECT name, checksum FROM app.schema_migrations')).rows.map(row => [row.name, row.checksum]));
    const results = [];
    for (const name of (await fs.readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const sql = await fs.readFile(path.join(directory, name), 'utf8');
      const checksum = sha256(sql);
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO app.schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      results.push(name);
    }
    return results;
  });
}

module.exports = { migrate };
