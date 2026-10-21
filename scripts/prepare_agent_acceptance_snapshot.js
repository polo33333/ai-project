'use strict';
// PostgreSQL REPEATABLE READ READ ONLY; export metadata, never credentials/SQL rows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  loadEnvironment();
  const pool = createPool({ runtime: true });
  try {
    const { documents } = await new PostgresRepository(pool).snapshot(['dictionary.json', 'glossary.json', 'library.json',
      'workflows.json', 'episodic_memory.json', 'ai_providers.json', 'db_sources.json']);
    const tables = (documents.get('dictionary.json') || []).filter(table => table.isActive !== false).map(table => ({
      tableId: table.tableId, tableName: table.tableName, schemaName: table.schemaName, dbSourceId: table.dbSourceId,
      description: table.tableDescription, domain: table.domain,
      columns: (table.columns || []).filter(column => column.isVisible !== false).map(column => ({
        name: column.columnName, label: column.displayName, description: column.description, isPrimaryKey: column.isPrimaryKey })) }));
    const library = (documents.get('library.json') || []).map(document => ({ id: document.id, title: document.title,
      revision: document.revision, status: document.status, manifestPath: document.manifestPath }));
    const workflows = (documents.get('workflows.json') || []).map(item => ({ id: item.id, name: item.name,
      status: item.status, packageVersion: item.packageVersion, templateCount: item.templates?.length || 0 }));
    const events = (documents.get('episodic_memory.json') || []).map(item => ({ id: item.id, ownerRef: hash(item.owner),
      revision: item.revision, status: item.status || null, scope: item.scope || null }));
    const providers = (documents.get('ai_providers.json') || []).map(item => ({ id: item.id, model: item.model,
      status: item.status, local: ['ollama', 'local'].includes(item.type) || item.executionClass === 'local' }));
    const sources = (documents.get('db_sources.json') || []).map(item => ({ id: item.id, name: item.name,
      status: item.status, policyRevision: item.governedPolicy?.revision || 0 }));
    const metadata = { tables, library, workflows, events, providers, sources };
    const snapshot = { schemaVersion: '1', createdAt: new Date().toISOString(), sourceRevision: hash(metadata),
      provenance: 'postgres_repeatable_read_read_only_metadata', ...metadata };
    const output = path.resolve(process.argv[2] || 'artifacts/agent-acceptance/snapshot.private.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(JSON.stringify({ output, sourceRevision: snapshot.sourceRevision, counts: {
      tables: tables.length, columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      documents: library.length, workflows: workflows.length, events: events.length, providers: providers.length, sources: sources.length
    } }, null, 2));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || 'SNAPSHOT_FAILED'); process.exitCode = 1; });
