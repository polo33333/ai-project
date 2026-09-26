'use strict';
// Domain stores are independent of legacy operation snapshots. Include them in
// preflight/import/export explicitly so changing storage backends loses no runs.
const files = { 'workflow_catalog.json': 'workflow_catalog', 'automation_runs.json': 'automation_runs' };
function validateDocuments(documents) {
  for (const [file, records] of Object.entries(documents)) {
    if (!Object.hasOwn(files, file) || !records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid automation import store.');
    for (const [id, document] of Object.entries(records)) {
      if (document.id !== id || !Number.isInteger(document.revision) || document.revision < 1 || !Number.isFinite(Date.parse(document.updatedAt))) throw new Error('Invalid automation import record.');
      if (file === 'automation_runs.json' && (!document.ownerId || !document.conversationId || !['CREATED', 'WAITING_INPUT', 'READY', 'RUNNING', 'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(document.status))) throw new Error('Invalid automation run owner/status.');
    }
  }
  return documents;
}
async function exists(client) { return Boolean((await client.query("SELECT to_regclass('app.workflow_catalog') AS name")).rows[0].name); }
async function read(client) {
  if (!await exists(client)) return {};
  const documents = {};
  for (const [file, table] of Object.entries(files)) documents[file] = Object.fromEntries((await client.query(`SELECT id,document FROM app.${table} ORDER BY id`)).rows.map(row => [row.id, row.document]));
  return documents;
}
async function insert(client, documents = {}) {
  validateDocuments(documents);
  if (!await exists(client)) { if (Object.values(documents).some(records => Object.keys(records).length)) throw new Error('Automation migration 004 required.'); return; }
  for (const [file, table] of Object.entries(files)) {
    if ((await client.query(`SELECT 1 FROM app.${table} LIMIT 1`)).rowCount) throw new Error(`Target is not empty: ${table}`);
    for (const document of Object.values(documents[file] || {})) {
      if (file === 'automation_runs.json') await client.query(`INSERT INTO app.${table}(id,revision,document,updated_at,owner_id,conversation_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)`, [document.id, document.revision, document, document.updatedAt, document.ownerId, document.conversationId, document.status]);
      else await client.query(`INSERT INTO app.${table}(id,revision,document,updated_at) VALUES($1,$2,$3,$4)`, [document.id, document.revision, document, document.updatedAt]);
    }
  }
}
async function verify(client, documents = {}) {
  const actual = await read(client), canonical = require('../../../scripts/postgres/model').canonical;
  for (const file of Object.keys(files)) if (canonical(actual[file] || {}) !== canonical(documents[file] || {})) throw new Error(`Automation round-trip verification failed: ${file}`);
}
module.exports = { files, read, insert, verify, validateDocuments };
