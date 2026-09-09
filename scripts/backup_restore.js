'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const command = process.argv[2];
const dataDirectory = path.resolve(process.env.KNOWLEDGEHUB_DATA_DIR || path.join(__dirname, '..', 'data'));
const backupRoot = path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const source = process.argv[3] ? path.resolve(process.argv[3]) : null;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(root) {
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result.push(absolute);
    }
  }
  if (fs.existsSync(root)) visit(root);
  return result;
}

if (command === 'backup') {
  const destination = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(dataDirectory, path.join(destination, 'data'), { recursive: true });
  const files = listFiles(path.join(destination, 'data')).map(file => ({ path: path.relative(path.join(destination, 'data'), file), sha256: hash(file), bytes: fs.statSync(file).size }));
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2));
  process.stdout.write(`${destination}\n`);
} else if (command === 'restore') {
  if (!source) throw new Error('Usage: npm run restore -- <backup-directory>');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  for (const item of manifest.files) {
    const file = path.resolve(source, 'data', item.path);
    if (!file.startsWith(path.resolve(source, 'data') + path.sep) || hash(file) !== item.sha256) throw new Error(`Backup checksum failed: ${item.path}`);
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.cpSync(path.join(source, 'data'), dataDirectory, { recursive: true, force: true });
  process.stdout.write(`Restored ${manifest.files.length} files to ${dataDirectory}\n`);
} else {
  throw new Error('Usage: node scripts/backup_restore.js <backup|restore> [backup-directory]');
}
