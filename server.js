'use strict';

const http = require('node:http');
const https = require('node:https');
const storage = require('./src/backend/storage');
const { handleStoredRequest } = require('./src/backend/storage/http');
const backupGate = require('./src/backend/services/backup_gate');
const { loadTlsConfig } = require('./src/backend/services/tls_config');
storage.loadEnvironment();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000));
let server;
let knowledgeCore;
let outbox;
let automation;
let shuttingDown = false;
async function start() {
  const tls = loadTlsConfig(process.env, __dirname);
  await storage.bootstrapStorage();
  let router;
  await storage.run(async () => {
    router = require('./src/backend/routes/router');
    knowledgeCore = require('./src/backend/knowledge_core');
    automation = require('./src/backend/automation');
    await automation.settings();
  });
  if (process.env.KNOWLEDGEHUB_WORKERS_ENABLED !== 'false') {
    await storage.run(() => knowledgeCore.start());
    if (storage.enabled()) { outbox = require('./src/backend/storage/postgres/outbox'); outbox.start(); }
    automation.runtime.start();
  }
  backupGate.configure({
    pause: async () => { if (automation) await automation.runtime.stop(); if (knowledgeCore) await knowledgeCore.stop(); if (outbox) await outbox.stop(); },
    resume: async () => { if (process.env.KNOWLEDGEHUB_WORKERS_ENABLED !== 'false') { if (automation) automation.runtime.start(); if (knowledgeCore) await storage.run(() => knowledgeCore.start()); if (outbox) outbox.start(); } }
  });
  const handleRequest = (req, res) => {
    const pathname = new URL(req.url, 'http://' + HOST).pathname;
    if (pathname === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' })); return;
    }
    if (pathname === '/health/ready') {
      storage.ready().then(result => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'ok', ...result }));
      }).catch(() => {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'error', message: 'STORAGE_NOT_READY' }));
      }); return;
    }
    if (!backupGate.enter(req, res)) return;
    const directBackup = pathname.startsWith('/api/backups/upload') || pathname.startsWith('/api/backups/download/');
    Promise.resolve(directBackup ? storage.run(() => router.handleRequest(req, res)) : handleStoredRequest(req, res, router.handleRequest)).catch(error => {
      console.error('[HTTP] Request failed:', error.code || error.name);
      if (!res.headersSent) res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      if (!res.writableEnded) res.end(JSON.stringify({ status: 'error', message: 'INVALID_REQUEST', requestId: req.requestId || null }));
    });
  };
  server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve); });
  const protocol = tls ? 'https' : 'http';
  console.log(`[KnowledgeHub] ${protocol}://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} storage=${process.env.APP_STORAGE_BACKEND || 'json'}`);
  if (HOST === '0.0.0.0') console.log(`[KnowledgeHub] LAN access: ${protocol}://<mac-mini-ip>:${PORT}`);
  if (process.env.KNOWLEDGEHUB_SUPERVISED === 'true') console.log('[Startup] Completed.');
}
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  console.log('[System] ' + signal + ': shutting down...');
  const forceTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS); forceTimer.unref();
  try {
    const closed = server ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    if (knowledgeCore) await knowledgeCore.stop();
    if (outbox) await outbox.stop();
    if (automation) await automation.runtime.stop();
    await closed; await storage.close(); clearTimeout(forceTimer); process.exit(0);
  } catch (error) { console.error('[System] Shutdown failed:', error.code || error.name); process.exit(1); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
start().catch(async error => {
  if (error.message === 'Unsupported state or unable to authenticate data') {
    console.error('[Startup] Failed: PostgreSQL contains encrypted data that cannot be decrypted with the configured APP_DATA_ENCRYPTION_KEY or APP_DATA_ENCRYPTION_KEY_FILE. After a restore, use the encryption key from the machine that created the backup; changing database credentials will not fix this.');
  } else console.error('[Startup] Failed:', error.code || error.message);
  await storage.close().catch(() => {}); process.exitCode = 1;
});
