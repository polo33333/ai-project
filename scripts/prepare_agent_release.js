'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseGate } = require('../src/backend/governance/operations');
const root = path.resolve(__dirname, '..');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function inventory(base, entries = ['src', 'scripts', 'server.js', 'package.json', 'package-lock.json']) {
  const result = [];
  for (const entry of entries) {
    const absolute = path.resolve(base, entry);
    if (!absolute.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(absolute)) throw new Error('RELEASE_PATH_INVALID');
    const files = fs.statSync(absolute).isDirectory() ? fs.readdirSync(absolute, { recursive: true })
      .filter(file => fs.statSync(path.join(absolute, file)).isFile()).map(file => path.join(entry, file)) : [entry];
    for (const file of files) result.push({ path: file.split(path.sep).join('/'), sha256: digest(fs.readFileSync(path.join(base, file))) });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function verify(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== '1' || !Array.isArray(manifest.files)) throw new Error('RELEASE_MANIFEST_INVALID');
  const base = path.join(path.dirname(path.resolve(manifestPath)), 'code');
  for (const file of manifest.files) {
    const absolute = path.resolve(base, file.path);
    if (!absolute.startsWith(base + path.sep) || !['src', 'scripts', 'server.js', 'package.json', 'package-lock.json'].some(prefix => file.path === prefix || file.path.startsWith(prefix + '/'))) throw new Error('RELEASE_PATH_INVALID');
    if (digest(fs.readFileSync(absolute)) !== file.sha256) throw new Error('RELEASE_CHECKSUM_MISMATCH');
  }
  if (digest(JSON.stringify(manifest.files)) !== manifest.revision) throw new Error('RELEASE_REVISION_MISMATCH');
  return { manifest, base };
}
function restore(manifestPath, target) {
  const { manifest, base } = verify(manifestPath), destination = path.resolve(target);
  if (fs.existsSync(destination)) throw new Error('RESTORE_REQUIRES_NEW_DIRECTORY');
  fs.mkdirSync(destination, { recursive: true });
  for (const file of manifest.files) {
    const output = path.resolve(destination, file.path);
    if (!output.startsWith(destination + path.sep)) throw new Error('RELEASE_PATH_INVALID');
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(base, file.path), output);
    if (digest(fs.readFileSync(output)) !== file.sha256) throw new Error('RESTORE_CHECKSUM_MISMATCH');
  }
  return { restoredFiles: manifest.files.length, revision: manifest.revision, target: destination };
}
function snapshot() {
  const files = inventory(root), revision = digest(JSON.stringify(files));
  const directory = path.join(root, 'artifacts', 'agent-releases', revision);
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    for (const file of files) { const output = path.join(directory, 'code', file.path); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(root, file.path), output); }
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: '1', revision, createdAt: new Date().toISOString(), files,
      excluded: ['environment', 'database', 'userFiles', 'permissions', 'memory'] }, null, 2));
  }
  verify(manifestPath);
  const check = restore(manifestPath, path.join(directory, `restore-check-${crypto.randomUUID()}`));
  const gate = releaseGate({ candidateRevision: revision, previousRevision: null, checks: { rollbackVerified: 'passed' } });
  fs.writeFileSync(path.join(directory, 'release-gate.json'), JSON.stringify(gate, null, 2));
  return { manifest: manifestPath, rollbackStagingCheck: check, gate };
}
if (require.main === module) {
  try {
    const [mode = 'snapshot', manifest, target] = process.argv.slice(2);
    const result = mode === 'snapshot' ? snapshot() : mode === 'verify' ? { revision: verify(manifest).manifest.revision, verified: true }
      : mode === 'restore' && target ? restore(manifest, target) : (() => { throw new Error('Usage: snapshot | verify <manifest> | restore <manifest> <new-directory>'); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, verify, restore };
