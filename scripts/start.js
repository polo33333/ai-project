'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadEnv() {
  const loaded = [];
  for (const name of ['.env', '.env.postgres']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) { process.env[key] = value; loaded.push(key); }
    }
  }
  process.env.KNOWLEDGEHUB_STARTUP_LOADED_KEYS = loaded.join(',');
}

function run(command, args, { quiet = false, timeout = 30000, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, windowsHide: true, stdio: quiet ? 'ignore' : 'inherit' });
  return !result.error && result.status === 0;
}

async function waitFor(check, ms, label) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready within ${Math.ceil(ms / 1000)} seconds.`);
}

async function reachable(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch { return false; }
}

const isLocal = value => {
  const host = new URL(value).hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
};

async function ensureDocker() {
  if (!run('docker', ['--version'], { quiet: true })) throw new Error('Docker CLI was not found. Install Docker Desktop and reopen the terminal.');
  if (!run('docker', ['info'], { quiet: true, timeout: 10000 })) {
    console.log('[Startup] Starting Docker Desktop...');
    if (!run('docker', ['desktop', 'start', '--detach'], { quiet: true, timeout: 15000 })) {
      if (process.platform === 'darwin') run('open', ['-a', 'Docker'], { quiet: true, timeout: 15000 });
      else if (process.platform === 'win32') {
        const candidate = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
        if (fs.existsSync(candidate)) { const child = spawn(candidate, [], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref(); }
      }
    }
    await waitFor(() => run('docker', ['info'], { quiet: true, timeout: 10000 }), 120000, 'Docker');
  }
  console.log('[OK] Docker is ready.');
}

function compose(service, env) {
  const file = path.join(root, 'compose.docker.yml');
  const args = ['compose', '--project-directory', root, '-f', file];
  const postgresEnv = path.join(root, '.env.postgres');
  if (fs.existsSync(postgresEnv)) args.push('--env-file', postgresEnv);
  args.push('up', '-d', '--no-deps', service);
  if (!run('docker', args, { timeout: 120000, env })) throw new Error(`Cannot create ${service} from compose.docker.yml.`);
}

async function ensurePostgres() {
  if (process.env.APP_STORAGE_BACKEND !== 'postgres') return;
  const host = process.env.APP_PG_HOST || '127.0.0.1';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) { console.log('[Startup] PostgreSQL uses an external host.'); return; }
  try {
    const { Client } = require('pg');
    const { connectionConfig } = require('../src/backend/storage/postgres/config');
    const client = new Client(connectionConfig({ runtime: Boolean(process.env.APP_PG_RUNTIME_USER) }));
    try { await client.connect(); await client.query('SELECT 1'); console.log('[OK] PostgreSQL is already available.'); return; }
    finally { await client.end().catch(() => {}); }
  } catch { /* A local Docker container may need to be started. */ }
  await ensureDocker();
  const name = process.env.APP_PG_DOCKER_CONTAINER || 'knowledgehub-postgres';
  if (run('docker', ['container', 'inspect', name], { quiet: true })) {
    if (!run('docker', ['start', name], { quiet: true })) throw new Error('Cannot start PostgreSQL container.');
  } else {
    if (name !== 'knowledgehub-postgres') throw new Error('Configured PostgreSQL container does not exist.');
    if (!fs.existsSync(path.join(root, '.env.postgres'))) throw new Error('.env.postgres is required to create the PostgreSQL container.');
    compose('postgres', process.env);
  }
  await waitFor(() => run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-p', '5432'], { quiet: true, timeout: 5000 }), 90000, 'PostgreSQL');
  console.log('[OK] PostgreSQL is ready.');
}

async function ensureQdrant() {
  const url = (process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
  const headers = process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {};
  if (!isLocal(url)) {
    if (!await reachable(`${url}/collections`, headers)) throw new Error('External Qdrant is unavailable.');
    console.log('[OK] External Qdrant is ready.'); return;
  }
  if (await reachable(`${url}/collections`, headers)) { console.log('[OK] Qdrant is already available.'); return; }
  await ensureDocker();
  const name = 'knowledgehub-qdrant';
  if (run('docker', ['container', 'inspect', name], { quiet: true })) {
    if (!run('docker', ['start', name], { quiet: true })) throw new Error('Cannot start Qdrant container.');
  } else {
    compose('qdrant', { ...process.env, POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || 'unused-for-qdrant' });
  }
  await waitFor(() => reachable(`${url}/collections`, headers), 90000, 'Qdrant');
  console.log('[OK] Qdrant is ready.');
}

function ollamaCommand() {
  if (run('ollama', ['--version'], { quiet: true, timeout: 5000 })) return 'ollama';
  if (process.platform === 'darwin') {
    const candidate = '/Applications/Ollama.app/Contents/Resources/ollama';
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    const candidate = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Ollama CLI was not found. Install Ollama or add it to PATH.');
}

async function ensureOllama() {
  if ((process.env.EMBEDDING_PROVIDER || 'ollama').toLowerCase() !== 'ollama') return;
  const base = (process.env.EMBEDDING_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const command = ollamaCommand();
  if (!await reachable(`${base}/api/tags`)) {
    if (!isLocal(base)) throw new Error('External Ollama is unavailable.');
    console.log('[Startup] Starting Ollama...');
    const child = spawn(command, ['serve'], { cwd: root, env: process.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    await waitFor(() => reachable(`${base}/api/tags`), 30000, 'Ollama');
  }
  const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Cannot list Ollama models.');
  const installed = new Set(((await response.json()).models || []).map(model => model.name));
  const names = [...new Set([process.env.EMBEDDING_MODEL || 'bge-m3', process.env.LOCAL_AI_MODEL || 'qwen3.5:9b'])];
  for (const name of names) {
    if (!installed.has(name) && !installed.has(`${name}:latest`) && !(name.endsWith(':latest') && installed.has(name.slice(0, -7)))) {
      console.log(`[Startup] Pulling Ollama model: ${name}`);
      if (!run(command, ['pull', name], { timeout: 0 })) throw new Error(`Cannot pull Ollama model: ${name}`);
    }
  }
  try {
    const warmup = await fetch(`${base}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: names[0], input: 'KnowledgeHub startup warmup' }), signal: AbortSignal.timeout(120000) });
    if (!warmup.ok) console.warn('[Startup] Embedding warm-up failed.');
  } catch { console.warn('[Startup] Embedding warm-up failed.'); }
  console.log('[OK] Ollama models are ready.');
}

async function startSupervisor() {
  const child = spawn(process.execPath, [path.join(__dirname, 'supervisor.js')], { cwd: root, env: process.env, stdio: 'inherit', windowsHide: true });
  const forward = signal => { if (!child.killed) child.kill(signal); };
  process.once('SIGINT', forward); process.once('SIGTERM', forward);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))); });
  process.exitCode = code;
}

async function main() {
  loadEnv();
  await ensurePostgres();
  await ensureQdrant();
  await ensureOllama();
  console.log('[Startup] Starting KnowledgeHub...');
  await startSupervisor();
}

if (require.main === module) main().catch(error => { console.error('[Startup]', error.message); process.exitCode = 1; });
module.exports = { loadEnv, isLocal, ensurePostgres, ensureQdrant, ensureOllama };
