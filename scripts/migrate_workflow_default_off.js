'use strict';
// Workflow packages become off by default: a function group lists the packages it turns on.
// Before, every published package was open to anyone with "workflows.use". To keep that,
// each group with "workflows.use" turns on every package published today, and keeps the
// unpublished packages it was already given, so they start on for that group alone. Runs once.
//   node scripts/migrate_workflow_default_off.js            → dry run, prints the report
//   node scripts/migrate_workflow_default_off.js --apply    → backs up the groups, then writes
const fs = require('node:fs');
const path = require('node:path');
const StorageHelper = require('../src/backend/utils/storage_helper');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const MARKER = '_workflow_default_off';

// Pure: the next groups and a report, from the groups and the workflow catalog records.
function plan(groups, records) {
  const published = records.filter(record => record.published && !record.id.startsWith('_')).map(record => record.id);
  const report = { published, groups: [] };
  const next = groups.map(group => {
    if (!group.permissions?.includes('workflows.use')) return group;
    const off = group.workflowsOff || [];
    const assigned = (group.workflows || []).filter(id => !published.includes(id));
    const workflows = [...published, ...assigned].filter(id => !off.includes(id));
    const { workflowsOff, ...rest } = group;
    report.groups.push({ id: group.id, name: group.name, before: group.workflows || [], after: workflows });
    return { ...rest, workflows, revision: (group.revision || 0) + 1, updatedBy: 'migration', updatedAt: new Date().toISOString() };
  });
  return { groups: next, report };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const automation = require('../src/backend/automation');
  if (await automation.repository.get('catalog', MARKER)) {
    process.stdout.write(`${JSON.stringify({ applied: false, reason: 'ALREADY_APPLIED' }, null, 2)}\n`); return;
  }
  const groups = StorageHelper.loadJson('account_function_groups.json', []);
  const { groups: next, report } = plan(groups, await automation.repository.list('catalog'));
  if (apply) {
    const backupDir = path.join(StorageHelper.getDataDirectory(), 'backup', `workflow-default-off-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'account_function_groups.json'), `${JSON.stringify(groups, null, 2)}\n`, { flag: 'wx' });
    StorageHelper.saveJson('account_function_groups.json', next);
    await automation.repository.put('catalog', { id: MARKER, appliedAt: new Date().toISOString(), published: report.published }, null);
    report.backup = backupDir;
  }
  process.stdout.write(`${JSON.stringify({ applied: apply, report }, null, 2)}\n`);
}

if (require.main === module) {
  (async () => {
    await storage.bootstrapStorage();
    try { await storage.run(main); } finally { await storage.close(); }
  })().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
module.exports = { plan };
