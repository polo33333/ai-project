'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const securityGuard = require('../src/backend/intelligent_core/security_guard');

const dataDir = process.env.KNOWLEDGEHUB_DATA_DIR || path.resolve(__dirname, '../data');
const files = ['chat_history.json', 'conversation_memory.json'];
const result = [];

for (const name of files) {
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
