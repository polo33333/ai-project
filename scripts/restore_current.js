'use strict';

const path = require('node:path');
const net = require('node:net');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { restoreCurrent } = require('./backup_all');

async function main() {
  loadEnvironment();
  const active = await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(process.env.PORT || 3000) });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
  if (active) throw new Error('Application port is still active. Stop the server before restoring current storage.');
  const id = process.argv[2];
  if (!/^storage-[0-9TZ-]+-[a-f0-9]{8}$/.test(id || '')) throw new Error('Invalid backup package ID.');
  const root = path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(__dirname, '../backups'));
  process.env.BACKUP_APP_STOPPED = '1';
  const result = await restoreCurrent(path.join(root, id));
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error('[Restore current]', error.code || error.message); process.exitCode = 1; });
