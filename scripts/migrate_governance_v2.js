'use strict';
// Moves governance data to function groups and version 2 policies.
//   node scripts/migrate_governance_v2.js            → dry run, prints the report
//   node scripts/migrate_governance_v2.js --apply    → backs up the stores, then writes
const fs = require('node:fs');
const path = require('node:path');
const StorageHelper = require('../src/backend/utils/storage_helper');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const { migrate } = require('../src/backend/governance/migration');
const FILES = ['db_sources.json', 'library.json', 'watchfolders.json', 'account_roles.json', 'accounts.json', 'account_function_groups.json'];

async function main() {
  const apply = process.argv.includes('--apply');
  const load = file => StorageHelper.loadJson(file, []);
  const [sources, documents, folders, roles, accounts, groups] = FILES.map(load);
  const tables = load('dictionary.json');
  const resources = [...sources.map(resource => ({ type: 'sql', resource })), ...documents.map(resource => ({ type: 'document', resource }))];
  const { data, report } = migrate({ resources, roles, accounts, groups, tables });
  if (report.mismatches.length) {
    process.stdout.write(`${JSON.stringify({ applied: false, reason: 'MISMATCH', report }, null, 2)}\n`);
    process.exitCode = 1; return;
  }
  if (apply) {
    const backupDir = path.join(StorageHelper.getDataDirectory(), 'backup', `governance-v1-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backupDir, { recursive: true });
    for (const [file, value] of FILES.map((file, index) => [file, [sources, documents, folders, roles, accounts, groups][index]]))
      fs.writeFileSync(path.join(backupDir, file), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    const byType = type => data.resources.filter(item => item.type === type).map(item => item.resource);
    StorageHelper.saveJson('db_sources.json', byType('sql'));
    StorageHelper.saveJson('library.json', byType('document'));
    StorageHelper.saveJson('account_function_groups.json', data.groups);
    StorageHelper.saveJson('account_roles.json', data.roles);
    StorageHelper.saveJson('accounts.json', data.accounts);
    report.backup = backupDir;
  }
  process.stdout.write(`${JSON.stringify({ applied: apply, report }, null, 2)}\n`);
}

(async () => {
  await storage.bootstrapStorage();
  try { await storage.run(main); } finally { await storage.close(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
