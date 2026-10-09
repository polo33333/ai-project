'use strict';
// Index published metadata only. Never execute workflows or business queries.
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { hash } = require('../src/backend/automation/contract');
const { service, configuration } = require('../src/backend/automation/workflow_retrieval');
async function main() {
  const pool = createPool({ runtime: true });
  let records;
  try { records = (await pool.query('SELECT document FROM app.workflow_catalog')).rows.map(row => row.document); }
  finally { await pool.end(); }
  const definitions = records.filter(record => record.enabled && record.published).flatMap(record => {
    const bundles = [record.published, ...Object.values(record.overlays || {}).filter(item => item.baseVersion === record.published.manifest.version).map(item => item.published).filter(Boolean)];
    return bundles.flatMap(bundle => bundle.templates.filter(item => item.enabled !== false && !record.deletedTemplates?.[item.id]).map(item => ({
      ...item, id: `${record.id}/${item.id}`, packageVersion: bundle.manifest.version, definitionHash: hash(item), domain: item.domain || bundle.manifest.domain || ''
    })));
  });
  const config = configuration();
  const checkOnly = process.argv.includes('--check');
  if (checkOnly) await service.checkIndex(definitions, config, AbortSignal.timeout(180000));
  else await service.sync(definitions, config, AbortSignal.timeout(180000));
  console.log(JSON.stringify({ status: 'ready', checkOnly, indexedDefinitions: definitions.length, collection: config.collection, model: config.model }));
}
main().catch(error => { console.error(error.code || 'INDEX_FAILED', error.message); process.exitCode = 1; });
