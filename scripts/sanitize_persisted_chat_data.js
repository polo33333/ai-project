'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const securityGuard = require('../src/backend/intelligent_core/security_guard');
const storage = require('../src/backend/storage');
const StorageHelper = require('../src/backend/utils/storage_helper');
storage.loadEnvironment();

const dataDir = process.env.KNOWLEDGEHUB_DATA_DIR || path.resolve(__dirname, '../data');
const files = ['chat_history.json', 'conversation_memory.json'];
const result = [];

async function main() {
await storage.bootstrapStorage();
try { await storage.run(() => {
for (const name of files) {
  if (storage.enabled()) {
    const value = StorageHelper.loadJson(name, name==='conversation_memory.json'?{sessions:{}}:[]);
    const sanitized = securityGuard.sanitizeStructuredData(value);
    const changed = JSON.stringify(value)!==JSON.stringify(sanitized);
    if (changed) StorageHelper.saveJson(name,sanitized);
    result.push({file:name,changed}); continue;
  }
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(before);
  const after = `${JSON.stringify(securityGuard.sanitizeStructuredData(parsed), null, 2)}\n`;
  if (after === before) { result.push({ file: name, changed: false }); continue; }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, after, { flag: 'wx' });
  fs.renameSync(temporary, file);
  result.push({ file: name, changed: true });
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}); } finally { await storage.close(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });
