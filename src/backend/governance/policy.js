'use strict';
// Pure policy rules. No storage and no request scope: context.js supplies the
// actor, the provider list and the watch folder a document inherits from.
const ACCESS_MODES = ['all', 'grants', 'admin'];
const AI_LEVELS = ['all', 'local', 'off'];
const PACKAGE_LEVELS = ['full', 'lookup'];
const READ_PERMISSION = { sql: 'sql:read', documents: 'knowledge:read', watchfolders: 'knowledge:read' };
const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item))] : [];

function kind(resource, type) {
  if (type === 'sql') return 'sql';
  if (type === 'document' || type === 'documents') return 'documents';
  if (type === 'watchfolder' || type === 'watchfolders') return 'watchfolders';
  return resource?.dbName !== undefined || resource?.database !== undefined || resource?.host !== undefined ? 'sql' : 'documents';
}

function defaults() {
  return { schemaVersion: 2, revision: 0, access: { mode: 'all', users: [], denyUsers: [] },
    aiSharing: { level: 'all', excludeDestinations: [] },
    sql: { allowedTables: [], blockedColumns: [], rowRules: [], packages: [], hiddenTables: [] }, inheritFrom: null };
}

function normalizePackages(value) {
  return (Array.isArray(value) ? value : []).filter(item => item && typeof item.id === 'string' && item.id).map(item => ({
    id: item.id, name: String(item.name || item.id), tables: list(item.tables), sensitiveColumns: list(item.sensitiveColumns),
    allowBridge: item.allowBridge !== false, base: item.base === true, baseLevel: PACKAGE_LEVELS.includes(item.baseLevel) ? item.baseLevel : 'full',
    lookupColumns: list(item.lookupColumns) }));
}

// Version 1 (visibility/sensitivity/modelDestinations) reads as version 2.
// Role and widget lists of version 1 stay as legacy* grants until the
// migration script moves them into function groups and widget roles.
function normalize(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const meta = { revision: raw.revision || 0, ...(raw.updatedBy ? { updatedBy: raw.updatedBy } : {}), ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}) };
  const legacy = { ...(list(raw.legacyRoles).length ? { legacyRoles: list(raw.legacyRoles) } : {}), ...(list(raw.legacyEmbeds).length ? { legacyEmbeds: list(raw.legacyEmbeds) } : {}) };
  if (raw.schemaVersion === 2) {
    const sql = raw.sql || {};
    return { ...base, ...meta, ...legacy,
      access: { mode: ACCESS_MODES.includes(raw.access?.mode) ? raw.access.mode : 'all', users: list(raw.access?.users), denyUsers: list(raw.access?.denyUsers) },
      aiSharing: { level: AI_LEVELS.includes(raw.aiSharing?.level) ? raw.aiSharing.level : 'all', excludeDestinations: list(raw.aiSharing?.excludeDestinations) },
      sql: { allowedTables: list(sql.allowedTables), blockedColumns: list(sql.blockedColumns), rowRules: Array.isArray(sql.rowRules) ? sql.rowRules : [],
        packages: normalizePackages(sql.packages), hiddenTables: list(sql.hiddenTables) },
      inheritFrom: typeof raw.inheritFrom === 'string' ? raw.inheritFrom : null };
  }
  const destinations = list(raw.modelDestinations);
  // Restricted sources that already named destinations keep reaching models;
  // the migration report lists them for review.
  const level = raw.sensitivity === 'restricted' && !destinations.length ? 'local' : 'all';
  return { ...base, ...meta,
    access: { mode: raw.visibility === 'restricted' ? 'grants' : 'all', users: list(raw.subjects), denyUsers: [] },
    aiSharing: { level, excludeDestinations: [] },
    sql: { ...base.sql, allowedTables: list(raw.allowedTables), blockedColumns: list(raw.blockedColumns) },
    ...(raw.visibility === 'restricted' && list(raw.roles).length ? { legacyRoles: list(raw.roles) } : {}),
    ...(list(raw.embedIds).length ? { legacyEmbeds: list(raw.embedIds) } : {}) };
}

// Why an actor may or may not read a resource. `options.policy` is the
// effective (possibly inherited) policy and `options.folderId` the watch folder.
function explain(resource, actor, type, options = {}) {
  const k = kind(resource, type), policy = options.policy || normalize(resource?.governedPolicy);
  const result = (allowed, reason) => ({ allowed, reason });
  if (!actor) return result(true, 'NO_SCOPE');
  if (actor.role === 'admin') return result(true, 'ADMIN');
  if (actor.channel === 'embed' && list(policy.legacyEmbeds).includes(actor.embedId)) return result(true, 'LEGACY_EMBED');
  // A widget without a resolved role has no read permission.
  const permissions = actor.channel === 'embed' && !Array.isArray(actor.permissions) ? [] : actor.permissions;
  if (Array.isArray(permissions) && !permissions.includes(READ_PERMISSION[k])) return result(false, 'MISSING_PERMISSION');
  if (k !== 'watchfolders' && Array.isArray(actor.dataAccess?.[k]) && !actor.dataAccess[k].includes(resource.id)) return result(false, 'LEGACY_SCOPE');
  if (policy.access.denyUsers.includes(actor.subject)) return result(false, 'DENIED_USER');
  if (policy.access.mode === 'all') return result(true, 'MODE_ALL');
  if (policy.access.mode === 'admin') return result(false, 'MODE_ADMIN');
  const grants = actor.grants || {};
  if (list(grants[k]).includes(resource.id)) return result(true, 'GRANT_FUNCTION_GROUP');
  if (options.folderId && list(grants.watchfolders).includes(options.folderId)) return result(true, 'GRANT_FOLDER');
  if (policy.access.users.includes(actor.subject)) return result(true, 'GRANT_USER');
  if (list(policy.legacyRoles).includes(actor.role)) return result(true, 'LEGACY_ROLE');
  return result(false, 'NOT_GRANTED');
}
const canRead = (resource, actor, type, options) => explain(resource, actor, type, options).allowed;

// Destination strings already used by refresh() callers.
function destination(id, local = false, providers = []) {
  const value = String(id || '');
  if (value === 'reranker') return { kind: 'reranker', id: value, local, name: 'Reranker' };
  const prefixed = /^(embedding|mcp|api|web):(.*)$/.exec(value);
  if (prefixed) return { kind: prefixed[1], id: value, local, name: prefixed[2] || value };
  const provider = providers.find(item => item.id === value);
  return { kind: 'provider', id: value, local, name: provider?.name || value, rejectInternalData: provider?.rejectInternalData === true };
}

// Web search is an extension everyone may use; it is not tied to source policy.
function canSend(policy, target, { toolEgress = true } = {}) {
  if (target.kind === 'web') return true;
  const level = policy.aiSharing.level;
  if (level === 'off') return false;
  if (target.kind === 'mcp' || target.kind === 'api') return level === 'all' && toolEgress;
  if (level === 'local') return target.local === true;
  if (target.kind === 'provider') return !target.rejectInternalData && !policy.aiSharing.excludeDestinations.includes(target.id);
  return true;
}

const levelRank = { lookup: 1, full: 2 };
const higherLevel = (a, b) => (levelRank[b] || 0) > (levelRank[a] || 0) ? b : a;

module.exports = { ACCESS_MODES, AI_LEVELS, PACKAGE_LEVELS, READ_PERMISSION, kind, defaults, normalize, explain, canRead, destination, canSend, higherLevel, list };
