'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const envPath = path.join(root, '.env');
let child = null;
let stopping = false;
let restartRequested = false;

function readEnvFile() {
  const values = {};
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

function start() {
  const env = { ...process.env, ...readEnvFile(), KNOWLEDGEHUB_SUPERVISED: 'true' };
  child = fork(serverPath, [], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  console.log(`[Supervisor] Server started (PID ${child.pid}).`);

  child.on('message', message => {
    if (message?.type !== 'restart' || stopping || restartRequested) return;
    restartRequested = true;
    console.log('[Supervisor] Restart requested from Settings UI.');
    child.kill('SIGTERM');
  });

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code || 0);
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
  if (child) child.kill('SIGTERM'); else process.exit(0);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
start();
