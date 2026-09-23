'use strict';

const http = require('node:http');
const storage = require('./src/backend/storage');
const { handleStoredRequest } = require('./src/backend/storage/http');
const backupGate = require('./src/backend/services/backup_gate');
storage.loadEnvironment();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000));
let server;
let knowledgeCore;
let outbox;
let shuttingDown = false;
async function start() {
  await storage.bootstrapStorage();
  let router;
  await storage.run(async () => {
    router = require('./src/backend/routes/router');
    knowledgeCore = require('./src/backend/knowledge_core');
  });
  if (process.env.KNOWLEDGEHUB_WORKERS_ENABLED !== 'false') {
    await storage.run(() => knowledgeCore.start());
    if (storage.enabled()) { outbox = require('./src/backend/storage/postgres/outbox'); outbox.start(); }
  }
  backupGate.configure({
    pause: async () => { if (knowledgeCore) await knowledgeCore.stop(); if (outbox) await outbox.stop(); },
    resume: async () => { if (process.env.KNOWLEDGEHUB_WORKERS_ENABLED !== 'false') { if (knowledgeCore) await storage.run(() => knowledgeCore.start()); if (outbox) outbox.start(); } }
  });
  server = http.createServer((req, res) => {
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
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve); });
  console.log('[KnowledgeHub] http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + ' storage=' + (process.env.APP_STORAGE_BACKEND || 'json'));
  if (HOST === '0.0.0.0') console.log(`[KnowledgeHub] LAN access: http://<mac-mini-ip>:${PORT}`);
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
    await closed; await storage.close(); clearTimeout(forceTimer); process.exit(0);
  } catch (error) { console.error('[System] Shutdown failed:', error.code || error.name); process.exit(1); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
start().catch(async error => {
  console.error('[Startup] Failed:', error.code || error.message);
  await storage.close().catch(() => {}); process.exitCode = 1;
});
