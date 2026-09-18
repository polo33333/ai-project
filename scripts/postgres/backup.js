'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { loadEnvironment, connectionConfig } = require('../../src/backend/storage/postgres/config');
const { createPool } = require('../../src/backend/storage/postgres/pool');
const { sha256 } = require('../../src/backend/storage/postgres/crypto');

function docker(command, args, { output, input, database } = {}) {
  const config = connectionConfig();
  const container = process.env.APP_PG_DOCKER_CONTAINER || 'knowledgehub-postgres';
  const child = spawn('docker', ['exec', ...(input ? ['-i'] : []), '-e', 'PGPASSWORD', container, command,
    '-h', '127.0.0.1', '-U', config.user, '-d', database || config.database, ...args], {
    env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stderr.resume(); // Do not emit database connection details or row contents.
  if (!input) child.stdin.end();
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} failed with exit code ${code}`)));
  });
  const streams = [];
  if (output) streams.push(pipeline(child.stdout, createWriteStream(output, { flags: 'wx', mode: 0o600 })));
  else child.stdout.resume();
  if (input) streams.push(pipeline(createReadStream(input), child.stdin));
  return Promise.all([completed, ...streams]);
}

async function main() {
  loadEnvironment();
  const [command, input, target] = process.argv.slice(2);
  if (command === 'backup') {
    const root = path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(__dirname, '../../backups'));
    await fs.mkdir(root, { recursive: true });
    const destination = path.join(root, `postgres-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
    await docker('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--schema=app'], { output: destination });
    const bytes = await fs.readFile(destination);
    await fs.writeFile(destination + '.manifest.json', JSON.stringify({ version: 1, bytes: bytes.length, sha256: sha256(bytes), createdAt: new Date().toISOString(), schema: 'app', encryptionKeyRequired: true }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ backup: destination, bytes: bytes.length }));
  } else if (command === 'restore') {
    if (!input || !target || !/^knowledgehub_restore_[a-z0-9_]+$/.test(target)) throw new Error('Restore requires a dump file and a NEW knowledgehub_restore_* database.');
    const file = path.resolve(input);
    const manifest = JSON.parse(await fs.readFile(file + '.manifest.json', 'utf8'));
    if (sha256(await fs.readFile(file)) !== manifest.sha256) throw new Error('Backup checksum mismatch.');
    const admin = createPool({ bootstrap: true });
    try {
      // CREATE DATABASE refuses an existing target. Never --clean an existing database.
      await admin.query(`CREATE DATABASE "${target}" OWNER knowledgehub_migrator TEMPLATE template0`);
    } finally { await admin.end(); }
    await docker('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl'], { input: file, database: target });
    console.log(JSON.stringify({ restored: target, schema: 'app', note: 'Verify data before switching any application connection.' }));
  } else throw new Error('Usage: backup.js backup | restore <dump-file> <new-knowledgehub_restore_database>');
}

if (require.main === module) main().catch(error => { console.error(error.code ? `Backup/restore failed (${error.code})` : error.message); process.exitCode = 1; });
module.exports = { docker };
