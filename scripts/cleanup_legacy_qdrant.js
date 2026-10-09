'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');
const { hash } = require('../src/backend/automation/contract');
const { service, configuration, identity } = require('../src/backend/automation/workflow_retrieval');
async function main() {
  loadEnvironment();
  const config = configuration();
  const active = [process.env.QDRANT_COLLECTION || 'database_schema_v2', process.env.QDRANT_DOCUMENT_COLLECTION || 'knowledge_documents_bge_m3_v1', config.collection];
  const endpoint = config.qdrantUrl.replace(/\/$/, '');
  const call = (route, method, body) => service.json(`${endpoint}${route}`, method || 'GET', body, AbortSignal.timeout(120000));
  const all = (await call('/collections')).result.collections.map(c => c.name);
  const obsolete = ['database_schema', 'knowledge_documents'].filter(name => all.includes(name) && !active.includes(name));
  const pool = createPool({ runtime: true });
  let records;
  try { records = (await pool.query('SELECT document FROM app.workflow_catalog')).rows.map(row => row.document); } finally { await pool.end(); }
  const definitions = records.filter(r => r.enabled && r.published).flatMap(r => [r.published, ...Object.values(r.overlays || {}).filter(o => o.baseVersion === r.published.manifest.version).map(o => o.published).filter(Boolean)].flatMap(b => b.templates.filter(t => t.enabled !== false && !r.deletedTemplates?.[t.id]).map(t => ({ ...t, id: `${r.id}/${t.id}`, packageVersion: b.manifest.version, definitionHash: hash(t), domain: t.domain || b.manifest.domain || '' }))));
  const tags = await service.json(`${config.embeddingUrl.replace(/\/$/, '')}/api/tags`, 'GET', undefined, AbortSignal.timeout(30000));
  config.modelDigest = tags.models.find(m => [config.model, `${config.model}:latest`].includes(m.name || m.model))?.digest;
  if (!config.modelDigest || !definitions.length) throw new Error('Cannot verify current workflow identities; cleanup stopped.');
  const current = new Set(definitions.map(d => identity(d, config).id));
  const points = []; let offset;
  do {
    const page = (await call(`/collections/${encodeURIComponent(config.collection)}/points/scroll`, 'POST', { limit: 100, with_payload: true, with_vector: false, ...(offset !== undefined ? { offset } : {}) })).result;
    points.push(...page.points); offset = page.next_page_offset;
  } while (offset != null);
  if ([...current].some(id => !points.some(p => p.id === id))) throw new Error('Current workflow vectors missing; cleanup stopped.');
  const stale = points.filter(p => !current.has(p.id)).map(p => p.id);
  const plan = { obsoleteCollections: obsolete, staleWorkflowPoints: stale.length, retainedWorkflowPoints: current.size };
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify(plan)); return; }
  const base = path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR || path.join(__dirname, '..', 'backups'), `qdrant-cleanup-${Date.now()}`);
  await fs.mkdir(base, { recursive: true });
  const snapshots = [];
  for (const name of [...obsolete, config.collection]) {
    const route = `/collections/${encodeURIComponent(name)}`;
    const info = (await call(route)).result;
    const snapshot = (await call(`${route}/snapshots?wait=true`, 'POST')).result;
    const response = await fetch(`${endpoint}${route}/snapshots/${encodeURIComponent(snapshot.name)}`, { headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Snapshot download HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('Empty safety snapshot');
    const filename = `${name}.snapshot`;
    await fs.writeFile(path.join(base, filename), buffer, { flag: 'wx' });
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (crypto.createHash('sha256').update(await fs.readFile(path.join(base, filename))).digest('hex') !== sha256) throw new Error('Safety snapshot checksum mismatch');
    snapshots.push({ collection: name, filename, bytes: buffer.length, sha256, pointsCount: info.points_count });
  }
  await fs.writeFile(path.join(base, 'manifest.json'), JSON.stringify({ ...plan, createdAt: new Date().toISOString(), snapshots, stalePointIds: stale, retainedPointIds: [...current], status: 'snapshots-verified' }, null, 2), { flag: 'wx' });
  for (const name of obsolete) await call(`/collections/${encodeURIComponent(name)}`, 'DELETE');
  if (stale.length) await call(`/collections/${encodeURIComponent(config.collection)}/points/delete?wait=true`, 'POST', { points: stale });
  const remaining = (await call('/collections')).result.collections.map(c => c.name);
  for (const name of active) if (!remaining.includes(name)) throw new Error(`Active collection missing: ${name}`);
  console.log(JSON.stringify({ ...plan, safetySnapshots: base, remainingCollections: remaining, workflowPoints: (await call(`/collections/${encodeURIComponent(config.collection)}`)).result.points_count }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
