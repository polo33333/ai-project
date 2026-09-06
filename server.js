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

const PORT = process.env.PORT || 3000;

knowledgeCore.start().catch(error => {
  console.error('[Knowledge] Failed to start module:', error);
});

const server = http.createServer((req, res) => {
  router.handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`=============================================================`);
  console.log(`🚀 KnowledgeHub AI Backend & Dashboard UI is running!`);
  console.log(`👉 Access Dashboard at: http://localhost:${PORT}`);
  console.log(`=============================================================`);
});

async function shutdown(signal) {
  console.log(`[System] ${signal}: shutting down...`);
  await knowledgeCore.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
