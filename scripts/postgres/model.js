'use strict';

const { sources, children, tables } = require('../../src/backend/storage/postgres/catalog');
const { sha256 } = require('../../src/backend/storage/postgres/crypto');

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function timestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string') return null;
  // Legacy toLocaleString('vi-VN'): interpret explicitly as Asia/Ho_Chi_Minh.
  const local = value.match(/^(?:(\d{1,2}):(\d{2}):(\d{2}),?\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (local) {
    const [, hh = '0', mm = '0', ss = '0', dd, month, year] = local;
    const parts = [+year, +month, +dd, +hh, +mm, +ss];
    const utc = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
    if (utc.getUTCFullYear() !== parts[0] || utc.getUTCMonth() !== parts[1] - 1 || utc.getUTCDate() !== parts[2] || +hh > 23 || +mm > 59 || +ss > 59) return null;
    return new Date(utc.getTime() - 7 * 3600000).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getAt(value, field) { return field.split('.').reduce((parent, key) => parent?.[key], value); }
function setAt(value, field, content) {
  const keys = field.split('.');
  let target = value;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  target[keys.at(-1)] = content;
}
function deleteAt(value, field) {
  const keys = field.split('.');
  const target = keys.slice(0, -1).reduce((parent, key) => parent?.[key], value);
  if (target) delete target[keys.at(-1)];
}

function buildModel(documents, { recordId, runtime = false } = {}) {
  const rows = Object.fromEntries(tables.map(table => [table, []]));
  const files = [];
  const warnings = [];
  function add(table, id, payload, ordinal, extra = {}) {
    id = String(id);
    if (rows[table].some(row => row.id === id)) throw new Error(`Duplicate identity in ${table} at ordinal ${ordinal}; import refused.`);
    const rawTime = payload?.timestamp ?? payload?.createdAt ?? payload?.startedAt;
    const created_at = timestamp(rawTime);
    if (rawTime && !created_at) warnings.push({ table, ordinal, reason: 'UNPARSED_TIMESTAMP_PRESERVED' });
    const row = { id, ordinal, payload, created_at, ...extra };
    rows[table].push(row);
    return row;
  }
  for (const source of sources) {
    if (!documents.has(source.file)) continue;
    const document = documents.get(source.file);
    let value = source.wrapper ? document[source.wrapper] : document;
    const arrayShape = source.shape === 'array' || source.shape === 'wrapped';
    if (arrayShape ? !Array.isArray(value) : (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`Invalid source shape: ${source.file}`);
    }
    const root = source.wrapper ? Object.fromEntries(Object.entries(document).filter(([key]) => key !== source.wrapper)) : {};
    const file = { ...source, root, checksum: sha256(canonical(document)), count: 0 };
    files.push(file);
    const entries = arrayShape ? value.map((entry, index) => [String(index), entry]) :
      source.shape === 'singleton' ? [['default', value]] : Object.entries(value);
    for (const [ordinal, [key, original]] of entries.entries()) {
      let payload = structuredClone(original);
      if (source.shape === 'aliases') {
        if (!Array.isArray(payload)) throw new Error('Domain aliases must be arrays.');
        payload = { domain: key, aliases: payload };
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`Invalid record: ${source.file} #${ordinal}`);
      const isMap = ['map', 'wrappedMap', 'aliases'].includes(source.shape);
      let id = isMap ? key : (source.idField && payload[source.idField]) || `legacy:${source.table}:${ordinal}`;
      if (!isMap && source.shape !== 'singleton' && recordId) id = recordId(source, original, ordinal);
      if (source.shape === 'singleton') id = 'default';
      if (source.table === 'auth_sessions') { id = sha256(key); payload._legacyToken = key; }
      const row = add(source.table, id, payload, ordinal, { source_key: source.table === 'auth_sessions' ? null : key });
      file.count++;
      for (const child of children[source.table] || []) {
        const values = getAt(payload, child.field);
        if (values === undefined) continue;
        if (!Array.isArray(values)) throw new Error(`Invalid ${source.table}.${child.field}`);
        row.child_fields ||= [];
        row.child_fields.push(child.field);
        deleteAt(payload, child.field);
        values.forEach((item, index) => add(child.table,
          // Existing child IDs may only be unique within their parent.
          `${id}:${child.field}:${index}`, item, index, { parent_id: String(id) }));
      }
      if (source.table === 'chat_sessions') {
        const fields = ['summary', 'activeScope', 'lastPlan', 'references', 'pendingTurn'];
        const memory = {};
        for (const field of fields) if (Object.hasOwn(payload, field)) { memory[field] = payload[field]; delete payload[field]; }
        add('memory_states', id, memory, 0, { parent_id: String(id) });
        // Unowned legacy memory is quarantined by scope, never assigned to a user.
        row.owner_scope = payload.accountId ? `account:${payload.accountId}` :
          runtime && payload.embedId ? `embed:${payload.embedId}` : `legacy-unowned:${id}`;
        row.client_session_id = payload.id || String(id);
        row.account_id = payload.accountId || null;
        if (!payload.accountId) warnings.push({ table: source.table, ordinal, reason: 'LEGACY_UNOWNED_MEMORY' });
      }
      if (source.table === 'auth_sessions') {
        row.account_id = payload.accountId || null;
        row.expires_at = timestamp(payload.expiresAt);
      }
      if (source.table === 'api_keys') row.key_hash = payload.key ? sha256(payload.key) : null;
      if (source.table === 'chat_feedback') row.run_id = payload.auditId || null;
      if (source.table === 'workflow_runs') row.workflow_id = payload.workflowId || null;
      if (source.table === 'chat_runs') row.completion_status = payload.status || 'UNKNOWN';
      if (source.table === 'dictionary_tables') {
        row.data_source_id = payload.dbSourceId || null;
        row.schema_name = payload.schemaName || null;
        row.table_name = payload.tableName || null;
      }
    }
  }
  // Preserve orphaned references in payload; do not manufacture parent entities.
  for (const [table, field, parent] of [
    ['chat_feedback', 'run_id', 'chat_runs'], ['workflow_runs', 'workflow_id', 'workflows'],
    ['dictionary_tables', 'data_source_id', 'data_sources'], ['auth_sessions', 'account_id', 'accounts'],
    ['chat_sessions', 'account_id', 'accounts']
  ]) {
    const ids = new Set(rows[parent].map(row => row.id));
    for (const row of rows[table]) if (row[field] && !ids.has(String(row[field]))) {
      warnings.push({ table, ordinal: row.ordinal, reason: `ORPHAN_${field.toUpperCase()}_PRESERVED` });
      if (table === 'chat_sessions') row.owner_scope = `legacy-unowned:${row.id}`;
      row[field] = null;
    }
  }
  return { rows, files, warnings };
}

function reconstruct(model) {
  const result = new Map();
  for (const source of model.files) {
    const records = [...model.rows[source.table]].sort((a, b) => a.ordinal - b.ordinal).map(row => {
      const payload = structuredClone(row.payload);
      for (const child of children[source.table] || []) if ((row.child_fields || []).includes(child.field)) {
        setAt(payload, child.field, model.rows[child.table].filter(item => item.parent_id === row.id).sort((a,b) => a.ordinal - b.ordinal).map(item => item.payload));
      }
      if (source.table === 'chat_sessions') Object.assign(payload, model.rows.memory_states.find(item => item.parent_id === row.id)?.payload || {});
      let key = row.source_key;
      if (source.table === 'auth_sessions') { key = payload._legacyToken; delete payload._legacyToken; }
      return [key, source.shape === 'aliases' ? payload.aliases : payload];
    });
    let value = ['array', 'wrapped'].includes(source.shape) ? records.map(([,value]) => value) :
      source.shape === 'singleton' ? records[0]?.[1] : Object.fromEntries(records);
    if (source.wrapper) value = { ...source.root, [source.wrapper]: value };
    result.set(source.file, value);
  }
  return result;
}

module.exports = { canonical, timestamp, buildModel, reconstruct };
