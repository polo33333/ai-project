'use strict';

const fs = require('node:fs');
const path = require('node:path');
const StorageHelper = require('../src/backend/utils/storage_helper');
const sqlConnector = require('../src/backend/services/sql_connector');
const { withIdentity } = require('../src/backend/services/schema_identity');

async function main() {
  const sources = StorageHelper.loadJson('db_sources.json', []);
  const tables = StorageHelper.loadJson('dictionary.json', []);
  const relationships = StorageHelper.loadJson('table_relationships.json', []);
  const sourceByDb = new Map(sources.map(source => [String(source.dbName).toLowerCase(), source]));
  const schemaBySourceAndTable = new Map();

  for (const source of sources.filter(item => item.mode === 'live' || item.type === 'Direct Live Connection')) {
    try {
      const rows = await sqlConnector.executeSqlQuery(
        'SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = \'BASE TABLE\'',
        source.id
      );
      for (const row of rows) schemaBySourceAndTable.set(`${source.id}::${String(row.TABLE_NAME).toLowerCase()}`, row.TABLE_SCHEMA || 'dbo');
    } catch (error) {
      process.stderr.write(`Schema lookup failed for ${source.id}; using dbo fallback: ${error.message}\n`);
    }
  }

  const migrated = tables.map(table => {
    const source = sourceByDb.get(String(table.dbName || '').toLowerCase());
    const dbSourceId = table.dbSourceId || source?.id || null;
    const schemaName = table.schemaName || schemaBySourceAndTable.get(`${dbSourceId}::${String(table.tableName).toLowerCase()}`) || 'dbo';
    return withIdentity({ ...table, dbSourceId, schemaName, identityRevision: 1 });
  });
  const byName = new Map(migrated.map(table => [table.tableName, table]));
  const migratedRelationships = relationships.map(relation => ({
    ...relation,
    sourceTableId: relation.sourceTableId || byName.get(relation.sourceTable)?.tableId || null,
    targetTableId: relation.targetTableId || byName.get(relation.targetTable)?.tableId || null,
    identityRevision: 1
  }));

  const dataDir = process.env.KNOWLEDGEHUB_DATA_DIR || path.resolve(__dirname, '../data');
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  for (const [name, value] of [['dictionary', tables], ['table_relationships', relationships]]) {
    const backup = path.join(backupDir, `${name}.identity-v1.backup.json`);
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  }
  StorageHelper.saveJson('dictionary.json', migrated);
  StorageHelper.saveJson('table_relationships.json', migratedRelationships);
  process.stdout.write(`${JSON.stringify({ tables: migrated.length, relationships: migratedRelationships.length, unresolvedSources: migrated.filter(table => !table.dbSourceId).length }, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
