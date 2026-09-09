/**
 * KnowledgeHub AI Server - Node.js Server Entrypoint
 * Serves Vanilla HTML/CSS/JS frontend & provides REST API endpoints via Router.
 */

const fs = require('fs');
const path = require('path');

// Auto-load .env file configuration
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key) {
        const envKey = key.trim();
        const envVal = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[envKey]) {
          process.env[envKey] = envVal;
        }
      }
    }
  }
}

const http = require('http');
const router = require('./src/backend/routes/router');
const knowledgeCore = require('./src/backend/knowledge_core');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000));

knowledgeCore.start().catch(error => {
  console.error('[Knowledge] Failed to start module:', error);
});

const server = http.createServer((req, res) => {
  Promise.resolve(router.handleRequest(req, res)).catch(error => {
    console.error('[HTTP] Unhandled request error:', error);
    if (!res.headersSent) res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ status: 'error', message: error.statusCode ? error.message : 'INVALID_REQUEST', requestId: req.requestId || null }));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`=============================================================`);
  console.log(`🚀 KnowledgeHub AI Backend & Dashboard UI is running!`);
  console.log(`👉 Access Dashboard at: http://${HOST}:${PORT}`);
  console.log(`=============================================================`);
});

async function shutdown(signal) {
  console.log(`[System] ${signal}: shutting down...`);
  const forceTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
  try {
    await Promise.all([
      knowledgeCore.stop(),
      new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    ]);
    clearTimeout(forceTimer);
    process.exit(0);
  } catch (error) {
    console.error('[System] Shutdown failed:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
