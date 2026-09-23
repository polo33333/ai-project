'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const envPath = path.join(root, '.env');
let child = null;
let stopping = false;
let restartRequested = false;
let restoreRequestedId = null;
let restoreChild = null;

function readEnvFile() {
  const values = {};
  for (const file of [envPath, path.join(root, '.env.postgres')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*=(.*)$/);
      if (match && values[match[1]] === undefined) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return values;
}

function effectiveEnv() {
  const explicit = { ...process.env };
  for (const key of (process.env.KNOWLEDGEHUB_STARTUP_LOADED_KEYS || '').split(',').filter(Boolean)) delete explicit[key];
  return { ...readEnvFile(), ...explicit, KNOWLEDGEHUB_SUPERVISED: 'true' };
}

function start() {
  const env = effectiveEnv();
  child = fork(serverPath, [], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  console.log(`[Supervisor] Server started (PID ${child.pid}).`);

  child.on('message', message => {
    if (stopping || restartRequested) return;
    if (message?.type === 'restore-current') {
      if (!/^storage-[0-9TZ-]+-[a-f0-9]{8}$/.test(message.id || '')) return;
      restoreRequestedId = message.id;
    } else if (message?.type !== 'restart') return;
    restartRequested = true;
    console.log(restoreRequestedId ? '[Supervisor] Stopping server to restore current storage.' : '[Supervisor] Restart requested from Settings UI.');
    child.kill('SIGTERM');
  });

  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping) process.exit(code || 0);
    if (restoreRequestedId) {
      if (code !== 0) { console.error('[Supervisor] Server did not stop cleanly; restore cancelled.'); process.exit(1); }
      const id = restoreRequestedId; restoreRequestedId = null;
      const env = { ...effectiveEnv(), BACKUP_APP_STOPPED: '1' };
      restoreChild = spawn(process.execPath, [path.join(__dirname, 'restore_current.js'), id], { cwd: root, env, stdio: 'inherit', windowsHide: true });
      const result = await new Promise(resolve => { restoreChild.once('error', () => resolve(1)); restoreChild.once('exit', value => resolve(value ?? 1)); });
      restoreChild = null;
      if (stopping) process.exit(result || 0);
      if (result !== 0) { console.error('[Supervisor] Restore failed. Server remains stopped; inspect the safety backup and restore report.'); process.exit(1); }
    }
    if (!restartRequested) {
      console.error(`[Supervisor] Server stopped unexpectedly (${signal || code}).`);
      process.exit(code || 1);
    }
    restartRequested = false;
    console.log('[Supervisor] Reloading .env and starting server again...');
    setTimeout(start, 500);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[Supervisor] ${signal}: stopping server...`);
  if (child) child.kill('SIGTERM');
  else if (restoreChild) restoreChild.kill('SIGTERM');
  else process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
start();
