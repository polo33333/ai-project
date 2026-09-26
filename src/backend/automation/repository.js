'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../storage');
const StorageHelper = require('../utils/storage_helper');

const conflict = () => Object.assign(new Error('Dữ liệu đã thay đổi. Hãy tải lại trước khi cập nhật.'), { statusCode: 409 });
// Separate domain repository: PostgreSQL CAS, or atomic JSON for a single server.
// No detached operation reuses a request's PostgreSQL snapshot.
class AutomationRepository {
  constructor({ directory = StorageHelper.getDataDirectory(), pool = null } = {}) {
    this.directory = directory; this.pool = pool;
  }
  database() { return this.pool || (storage.enabled() ? storage.getPool() : null); }
  file(kind) { return path.join(this.directory, kind === 'catalog' ? 'workflow_catalog.json' : 'automation_runs.json'); }
  readFile(kind) {
    const file = this.file(kind);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  writeFile(kind, records) {
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(kind), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(records), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  table(kind) { if (!['catalog', 'runs'].includes(kind)) throw new Error('Invalid repository kind'); return kind === 'catalog' ? 'workflow_catalog' : 'automation_runs'; }
  async get(kind, id) {
    const db = this.database();
    if (db) return (await db.query(`SELECT document FROM app.${this.table(kind)} WHERE id=$1`, [id])).rows[0]?.document || null;
    return this.readFile(kind)[id] || null;
  }
  async runSummaries(ownerId, conversationId) {
    const db=this.database();
    if(db) {
      const values=[ownerId]; const conversation=conversationId?' AND conversation_id=$2':''; if(conversationId)values.push(conversationId);
      const rows=(await db.query(`SELECT id, document->>'status' AS status, document->'definition'->>'name' AS name, document->>'updatedAt' AS "updatedAt" FROM app.automation_runs WHERE owner_id=$1${conversation} ORDER BY updated_at DESC LIMIT 100`,values)).rows;
      return rows;
    }
    return (await this.list('runs',{ownerId,conversationId})).slice(0,100).map(run=>({id:run.id,status:run.status,name:run.definition.name,updatedAt:run.updatedAt}));
  }
  async list(kind, { ownerId, conversationId, statuses } = {}) {
    const db = this.database();
    if (db) {
      const clauses = [], values = [];
      if (kind === 'runs') {
        if (ownerId) { values.push(ownerId); clauses.push(`owner_id=$${values.length}`); }
        if (conversationId) { values.push(conversationId); clauses.push(`conversation_id=$${values.length}`); }
        if (statuses) { values.push(statuses); clauses.push(`status=ANY($${values.length}::text[])`); }
      }
      return (await db.query(`SELECT document FROM app.${this.table(kind)}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC`, values)).rows.map(row => row.document);
    }
    return Object.values(this.readFile(kind)).filter(item => (!ownerId || item.ownerId === ownerId) && (!conversationId || item.conversationId === conversationId) && (!statuses || statuses.includes(item.status))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async put(kind, document, expectedRevision = null) {
    const next = structuredClone({ ...document, revision: (expectedRevision || 0) + 1, updatedAt: new Date().toISOString() });
    const db = this.database();
    if (db) {
      let result;
      if (expectedRevision === null) {
        const columns = kind === 'runs' ? ',owner_id,conversation_id,status' : '';
        const placeholders = kind === 'runs' ? ',$4,$5,$6' : '';
        const values = [next.id, next.revision, next];
        if (kind === 'runs') values.push(next.ownerId, next.conversationId, next.status);
        result = await db.query(`INSERT INTO app.${this.table(kind)}(id,revision,document${columns}) VALUES($1,$2,$3${placeholders}) ON CONFLICT DO NOTHING RETURNING id`, values);
      } else {
        const values = [next.id, next.revision, next, expectedRevision];
        if (kind === 'runs') values.push(next.status);
        result = await db.query(`UPDATE app.${this.table(kind)} SET revision=$2,document=$3,updated_at=now()${kind === 'runs' ? ',status=$5' : ''} WHERE id=$1 AND revision=$4 RETURNING id`, values);
      }
      if (!result.rowCount) throw conflict();
    } else {
      // Read/check/write are synchronous: no await between them.
      const records = this.readFile(kind), previous = records[next.id];
      if (expectedRevision === null ? previous : previous?.revision !== expectedRevision) throw conflict();
      records[next.id] = next; this.writeFile(kind, records);
    }
    return next;
  }
}
module.exports = { AutomationRepository, conflict };
