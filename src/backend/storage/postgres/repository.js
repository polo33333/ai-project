'use strict';

const crypto = require('node:crypto');
const { sources, tables, children: childTables } = require('./catalog');
const { transaction } = require('./pool');
const { protect, encrypt, decrypt } = require('./crypto');
const { encode, decode } = require('./codec');
const { buildModel, canonical, reconstruct, timestamp } = require('../../../../scripts/postgres/model');

const identity = Symbol('postgres-record-id');
const children = new Set(['dictionary_columns', 'chat_messages', 'tool_executions', 'workflow_steps', 'domain_aliases', 'memory_states']);
const sourcesByFile = new Map(sources.map(source => [source.file, source]));
const conflict = () => Object.assign(new Error('DATA_CONFLICT: dữ liệu đã được cập nhật bởi thao tác khác. Hãy tải lại và thử lại.'), { statusCode: 409, code: 'DATA_CONFLICT' });
const equal = (a, b) => canonical(a) === canonical(b);

function defaultValue(source) {
  if (source.shape === 'array') return [];
  if (source.shape === 'wrapped') return { [source.wrapper]: [] };
  if (source.shape === 'wrappedMap') return { [source.wrapper]: {} };
  return {};
}

function records(source, document) {
  const value = source.wrapper ? document?.[source.wrapper] : document;
  if (source.shape === 'array' || source.shape === 'wrapped') return (value || []).map((record, index) => [String(index), record]);
  if (source.shape === 'singleton') return document ? [['default', document]] : [];
  return Object.entries(value || {});
}

function recordId(source, record) {
  const existing = (source.idField && record?.[source.idField]) || record?.[identity];
  if (existing) return String(existing);
  const id = crypto.randomUUID();
  Object.defineProperty(record, identity, { value: id, configurable: true });
  return id;
}

function recordMap(source, document) {
  return new Map(records(source, document).map(([key, value]) => [
    ['array', 'wrapped'].includes(source.shape) ? recordId(source, value) : key, value
  ]));
}

function appendedMessages(base, proposed) {
  const previous = base?.messages || [];
  const next = proposed?.messages || [];
  for (let retained = Math.min(previous.length, next.length); retained >= 0; retained--) {
    if (equal(previous.slice(previous.length - retained), next.slice(0, retained))) {
      const appended = next.slice(retained);
      if (!appended.length || appended.length % 2 || appended.some((message, i) => message.role !== (i % 2 ? 'assistant' : 'user'))) return null;
      return appended;
    }
  }
  return null;
}

function mergeRecord(source, base, proposed, fresh) {
  if (equal(base, fresh)) return proposed;
  if (proposed === undefined || fresh === undefined) throw conflict();
  if (equal(proposed, fresh)) return fresh;
  if (source.table === 'chat_sessions') {
    if (fresh.accountId !== proposed.accountId || fresh.embedId !== proposed.embedId) throw conflict();
    const appended = appendedMessages(base, proposed);
    if (appended) {
      const messages = [...(fresh.messages || []), ...appended];
      const configured = Math.max(4, Number(process.env.AI_MEMORY_MAX_MESSAGES || 40));
      const max = configured - configured % 2;
      const newer = String(proposed.updatedAt || '') >= String(fresh.updatedAt || '');
      return { ...fresh, ...(newer ? proposed : {}), messages: messages.slice(-max) };
    }
    // Pending turns never erase an exchange committed by another request.
    if (base && equal(base.messages, proposed.messages)) {
      return { ...fresh, pendingTurn: fresh.updatedAt > proposed.updatedAt ? fresh.pendingTurn : proposed.pendingTurn };
    }
  }
  if (source.table === 'auth_sessions' && base && base.accountId === fresh.accountId && fresh.accountId === proposed.accountId) {
    return { ...fresh, expiresAt: Math.max(fresh.expiresAt, proposed.expiresAt), persistedAt: Math.max(fresh.persistedAt || 0, proposed.persistedAt || 0) };
  }
  // Independent edits to different fields can safely share an entity.
  if (base && typeof base === 'object' && !Array.isArray(base)) {
    const merged = structuredClone(fresh);
    for (const key of new Set([...Object.keys(base), ...Object.keys(proposed)])) {
      if (equal(base[key], proposed[key])) continue;
      if (!equal(base[key], fresh[key]) && !equal(proposed[key], fresh[key])) {
        if (source.table === 'accounts' && key === 'lastLoginAt') { merged[key] = [fresh[key], proposed[key]].sort().at(-1); continue; }
        if(source.table==='watchfolders'&&['lastScan','scannedFiles'].includes(key)) {
          const freshTime=timestamp(fresh.lastScan)||'';
          const proposedTime=timestamp(proposed.lastScan)||'';
          merged[key]=proposedTime>=freshTime?proposed[key]:fresh[key];continue;
        }
        throw conflict();
      }
      if (Object.hasOwn(proposed, key)) merged[key] = proposed[key];
      else delete merged[key];
    }
    if (fresh[identity]) Object.defineProperty(merged, identity, { value: fresh[identity], configurable: true });
    return merged;
  }
  throw conflict();
}

function mergeDocument(source, base, proposed, fresh) {
  const before = recordMap(source, base);
  const after = recordMap(source, proposed);
  const current = recordMap(source, fresh);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id);
    const value = after.get(id);
    if (equal(old, value)) continue;
    const merged = mergeRecord(source, old, value, current.get(id));
    if (merged === undefined) current.delete(id);
    else current.set(id, merged);
  }
  // Local ordering wins for records the operation saw; concurrent insertions
  // remain present. This never replaces the collection with a stale snapshot.
  const ordered = new Map();
  for (const id of after.keys()) if (current.has(id)) ordered.set(id, current.get(id));
  for (const [id, value] of current) if (!ordered.has(id)) ordered.set(id, value);
  let document;
  if (['array', 'wrapped'].includes(source.shape)) document = [...ordered.values()];
  else if (source.shape === 'singleton') document = ordered.get('default') || {};
  else document = Object.fromEntries(ordered);
  if (source.wrapper) {
    const baseRoot = { ...base }; delete baseRoot[source.wrapper];
    const proposedRoot = { ...proposed }; delete proposedRoot[source.wrapper];
    const freshRoot = { ...fresh }; delete freshRoot[source.wrapper];
    const root = mergeRecord({ table: 'wrapper' }, baseRoot, proposedRoot, freshRoot);
    document = { ...root, [source.wrapper]: document };
  }
  return document;
}

async function loadModel(client, selectedFiles) {
  const selected = selectedFiles ? new Set(selectedFiles) : null;
  const roots = (await client.query(selected ? 'SELECT file, root FROM app.domain_stores WHERE file=ANY($1::text[])' : 'SELECT file, root FROM app.domain_stores',selected ? [[...selected]] : [])).rows;
  const files = roots.map(row => {
    const source = sourcesByFile.get(row.file);
    if (!source) throw new Error('Unknown PostgreSQL domain store.');
    return { ...source, root: protect(row.root, `file/${row.file}`, true) };
  });
  const requested = new Set();
  for (const source of sources) if (!selected || selected.has(source.file)) {
    requested.add(source.table);
    for (const child of childTables[source.table] || []) requested.add(child.table);
    if (source.table==='chat_sessions') requested.add('memory_states');
  }
  const rows = {};
  for (const table of tables) {
    if (!requested.has(table)) { rows[table]=[]; continue; }
    rows[table] = (await client.query(`SELECT * FROM app.${table} ORDER BY ordinal, id`)).rows;
    for (const row of rows[table]) row.payload = decode(table, row.id, row.payload);
  }
  const model = { files, rows };
  const documents = reconstruct(model);
  for (const source of sources) {
    if (!documents.has(source.file)) continue;
    if (['array', 'wrapped'].includes(source.shape)) {
      const values = records(source, documents.get(source.file));
      values.forEach(([,record], index) => Object.defineProperty(record, identity, { value: rows[source.table][index].id, configurable: true }));
    }
  }
  return { model, documents };
}

const serializedFields = new Set(['payload', 'child_fields']);
async function insertRow(client, table, row) {
  const keys = Object.keys(row);
  const values = keys.map(key => serializedFields.has(key) ? JSON.stringify(key === 'payload' ? encode(table, row.id, row[key]) : row[key]) : row[key]);
  await client.query(`INSERT INTO app.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, values);
}

function comparable(row) {
  const result = { ...row };
  delete result.version; delete result.updated_at;
  for (const [key, value] of Object.entries(result)) if (value instanceof Date) result[key] = value.toISOString();
  // Database defaults absent from the import/model builder.
  result.child_fields ||= [];
  return result;
}

class PostgresRepository {
  constructor(pool) { this.pool = pool; }

  async snapshot(files) {
    return transaction(this.pool, client => loadModel(client,files), { readOnly: true });
  }

  async commit(work) {
    if (!work.dirty.size && !work.jobs.length && !work.receipt) return;
    return transaction(this.pool, async client => {
      // Serialize only the short write phase; NEVER hold a lock during model,
      // SQL Server, filesystem processing or Qdrant requests.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('knowledgehub-runtime-commit'))");
      if(work.receipt) {
        const receipt=(await client.query('SELECT body_hash,response FROM app.chat_request_receipts WHERE key=$1',[work.receipt.key])).rows[0];
        if(receipt) {
          if(receipt.body_hash!==work.receipt.bodyHash)throw conflict();
          work.receipt.replay=decrypt(receipt.response,`receipt/${work.receipt.key}`);
          return;
        }
      }
      const already = await client.query('SELECT 1 FROM app.operation_commits WHERE operation_id=$1', [work.id]);
      if (already.rowCount) return;
      const fresh = await loadModel(client);
      for (const file of work.dirty) {
        const source = sourcesByFile.get(file);
        const empty = defaultValue(source);
        const document = mergeDocument(source, work.baseline.get(file) || empty, work.documents.get(file), fresh.documents.get(file) || empty);
        fresh.documents.set(file, document);
      }
      const target = buildModel(fresh.documents, { recordId, runtime: true });
      for (const row of target.rows.ai_providers) row.is_active = row.payload.isActive === true;
      if (target.rows.ai_providers.filter(row => row.is_active).length > 1) throw conflict();
      for (const row of target.rows.chat_sessions) row.embed_id = row.payload.embedId || null;
      const sessionIds = new Set(target.rows.chat_sessions.map(row => row.id));
      for (const row of target.rows.chat_runs) {
        const decision = row.payload.requestPayload?.memoryDecision;
        const key = decision?.accountId && decision.sessionId ? `${decision.accountId}__${decision.sessionId}` : decision?.sessionId;
        const old = fresh.model.rows.chat_runs.find(item => item.id === row.id);
        row.session_id = old?.session_id || (key && sessionIds.has(key) ? key : null);
        row.request_id = old?.request_id || row.payload.requestId || null;
      }
      const deletions = [];
      const changes = [];
      const orderChanges = [];
      for (const table of tables) {
        const existing = new Map(fresh.model.rows[table].map(row => [row.id, row]));
        const wanted = new Map(target.rows[table].map(row => [row.id, row]));
        for (const row of existing.values()) if (!wanted.has(row.id)) deletions.push([table, row]);
        for (const row of wanted.values()) {
          const previous = existing.get(row.id);
          const before = previous && comparable(previous);
          const after = comparable(row);
          if (before) {
            // Preserve explicit database defaults and historical timestamps.
            for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) after[key] = before[key];
            const oldOrder = before.ordinal; const newOrder = after.ordinal;
            delete before.ordinal; delete after.ordinal;
            delete before.source_key; delete after.source_key;
            if (equal(before, after)) {
              if (oldOrder !== newOrder) orderChanges.push([table, row.id, newOrder]);
              continue;
            }
          }
          changes.push([table, row, previous]);
        }
      }
      // Temporarily move child ordinals out of the occupied range: unique
      // (parent, sequence) remains valid when trimming/reordering messages.
      for (const table of children) {
        const affected = new Set(changes.filter(([t]) => t === table).map(([,row]) => row.parent_id));
        orderChanges.filter(([t]) => t === table).forEach(([,id]) => affected.add(fresh.model.rows[table].find(row => row.id === id)?.parent_id));
        for (const parent of affected) if (parent) await client.query(`UPDATE app.${table} SET ordinal=ordinal+1000000 WHERE parent_id=$1`, [parent]);
      }
      // Child deletions first, then roots. FK SET NULL/CASCADE policies apply.
      deletions.sort(([a], [b]) => Number(children.has(b)) - Number(children.has(a)));
      for (const [table, row] of deletions) await client.query(`DELETE FROM app.${table} WHERE id=$1`, [row.id]);
      // Remove old provider selection before setting the new one.
      if (changes.some(([table]) => table === 'ai_providers')) await client.query('UPDATE app.ai_providers SET is_active=false WHERE is_active');
      changes.sort(([a], [b]) => Number(children.has(a)) - Number(children.has(b)));
      for (const [table, row, previous] of changes) {
        if (!previous) await insertRow(client, table, row);
        else {
          const keys = Object.keys(row).filter(key => key !== 'id');
          const values = keys.map(key => serializedFields.has(key) ? JSON.stringify(key === 'payload' ? encode(table, row.id, row[key]) : row[key]) : row[key]);
          await client.query(`UPDATE app.${table} SET ${keys.map((key,i) => `${key}=$${i+1}`).join(',')}, version=version+1, updated_at=now() WHERE id=$${keys.length+1}`, [...values, row.id]);
        }
      }
      for (const [table, id, ordinal] of orderChanges) await client.query(`UPDATE app.${table} SET ordinal=$2 WHERE id=$1`, [id, ordinal]);
      if (changes.some(([table]) => table === 'ai_providers')) {
        const selected = target.rows.ai_providers.find(row => row.is_active);
        if (selected) await client.query('UPDATE app.ai_providers SET is_active=true WHERE id=$1', [selected.id]);
      }
      // Restore unaffected children whose ordinals were moved with their parent.
      for (const table of children) await client.query(`UPDATE app.${table} SET ordinal=ordinal-1000000 WHERE ordinal>=1000000`);
      for (const file of target.files) {
        if (!work.dirty.has(file.file)) continue;
        await client.query(`INSERT INTO app.domain_stores(file, root) VALUES($1,$2)
          ON CONFLICT(file) DO UPDATE SET root=excluded.root, revision=app.domain_stores.revision+1`,
        [file.file, JSON.stringify(protect(file.root, `file/${file.file}`))]);
      }
      for (const job of work.jobs) await client.query(`INSERT INTO app.outbox_jobs(id, kind, resource_id, payload) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
        [job.id, job.kind, job.resourceId, JSON.stringify(protect(job.payload, `outbox/${job.id}`))]);
      await client.query('INSERT INTO app.operation_commits(operation_id) VALUES($1)', [work.id]);
      if(work.receipt)await client.query('INSERT INTO app.chat_request_receipts(key,body_hash,response) VALUES($1,$2,$3)',[
        work.receipt.key,work.receipt.bodyHash,JSON.stringify(encrypt(work.receipt.response,`receipt/${work.receipt.key}`))
      ]);
    });
  }
}

module.exports = { PostgresRepository, loadModel, mergeDocument, recordId, identity };
