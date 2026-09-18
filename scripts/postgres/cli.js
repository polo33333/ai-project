'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadEnvironment } = require('../../src/backend/storage/postgres/config');
const { createPool, transaction } = require('../../src/backend/storage/postgres/pool');
const { migrate } = require('../../src/backend/storage/postgres/migrate');
const { snapshot, readSnapshot, inventory } = require('./snapshot');
const { importSnapshot, verifySnapshot, readModel } = require('./transfer');
const { reconstruct } = require('./model');

const root = path.resolve(__dirname, '../..');
loadEnvironment(root);

async function initialize() {
  if (process.env.APP_PG_USER || process.env.APP_PG_PASSWORD || process.env.APP_DATA_ENCRYPTION_KEY_FILE) throw new Error('Storage credentials already exist. Initialization will not replace them.');
  const pool = createPool({ bootstrap: true });
  const password = crypto.randomBytes(32).toString('hex');
  const runtimePassword = crypto.randomBytes(32).toString('hex');
  const keyDirectory = path.join(os.homedir(), '.knowledgehub', 'keys');
  const keyFile = path.join(keyDirectory, `postgres-${crypto.randomUUID()}.key`);
  try {
    await fs.mkdir(keyDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(keyFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    await transaction(pool, async client => {
      // Identifiers are constants; passwords are generated hex, never user input.
      await client.query(`CREATE ROLE knowledgehub_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
      await client.query(`CREATE ROLE knowledgehub_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword}'`);
      const { rows: [database] } = await client.query('SELECT current_database() AS name');
      const identifier = '"' + database.name.replace(/"/g, '""') + '"';
      await client.query(`GRANT CONNECT, CREATE ON DATABASE ${identifier} TO knowledgehub_migrator`);
      await client.query(`GRANT CONNECT ON DATABASE ${identifier} TO knowledgehub_runtime`);
    });
    await fs.appendFile(path.join(root, '.env.postgres'), `\n# App migration credentials (runtime is not switched yet)\nAPP_PG_USER=knowledgehub_migrator\nAPP_PG_PASSWORD=${password}\nAPP_PG_RUNTIME_USER=knowledgehub_runtime\nAPP_PG_RUNTIME_PASSWORD=${runtimePassword}\nAPP_DATA_ENCRYPTION_KEY_FILE=${keyFile}\n`, { mode: 0o600 });
    console.log('Migration/runtime roles created. Encryption key stored separately in ~/.knowledgehub/keys. Keep this key with your disaster-recovery secrets.');
  } finally { await pool.end(); }
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === 'init') return initialize();
  if (command === 'snapshot' || command === 'preflight') {
    const result = await snapshot(process.env.KNOWLEDGEHUB_DATA_DIR || path.join(root, 'data'), process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(root, 'backups'));
    const loaded = await readSnapshot(result.directory);
    const report = { snapshot: result.directory, sourceFiles: loaded.model.files.map(file => ({ file: file.file, count: file.count })), warnings: loaded.model.warnings };
    await fs.writeFile(path.join(result.directory, 'preflight.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const pool = createPool();
  try {
    if (command === 'migrate') {
      console.log(JSON.stringify({ applied: await migrate(pool) }));
      await require('../../src/backend/storage/postgres/permissions').grantRuntime(pool);
    } else if (command === 'import' || command === 'verify') {
      if (!argument) throw new Error('A verified snapshot directory is required.');
      const loaded = await readSnapshot(path.resolve(argument));
      const report = await (command === 'import' ? importSnapshot(pool, loaded) : verifySnapshot(pool, loaded));
      await fs.writeFile(path.join(argument, `${command}-report.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ ok: report.ok, alreadyImported: report.alreadyImported, files: report.files.length, tables: report.tables, warnings: report.warnings?.length || 0 }, null, 2));
    } else if (command === 'export') {
      if (!argument) throw new Error('A NEW export directory is required.');
      const destination = path.resolve(argument);
      // mkdir without recursive intentionally refuses existing destinations.
      await fs.mkdir(destination, { mode: 0o700 });
      const documents = await transaction(pool, async client => reconstruct(await readModel(client)), { readOnly: true });
      for (const [file, value] of documents) {
        const absolute = path.resolve(destination, file);
        if (!absolute.startsWith(destination + path.sep)) throw new Error('Unsafe export path.');
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
      }
      console.log(JSON.stringify({ exportedFiles: documents.size, directory: destination, files: (await inventory(destination)).length }));
    } else throw new Error('Usage: cli.js init|preflight|migrate|import <snapshot>|verify <snapshot>|export <new-directory>');
  } finally { await pool.end(); }
}

main().catch(error => {
  // PostgreSQL detail/connection errors may include credentials or row values.
  console.error(error.code ? `PostgreSQL operation failed (${error.code}). No credential details logged.` : error.message);
  process.exitCode = 1;
});
