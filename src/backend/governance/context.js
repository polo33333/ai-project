'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const scopes = new AsyncLocalStorage();
const denied = code => Object.assign(new Error('Không có quyền truy cập tài nguyên hoặc đích xử lý.'), { code, statusCode: 403 });
function run(operation) { return scopes.run({ principal: null, resources: new Map() }, operation); }
function isolateResources(operation) {
  const scope = current();
  return scope ? scopes.run({ ...scope, resources: new Map() }, operation) : operation();
}
function setPrincipal(principal, revalidate) {
  const scope = scopes.getStore();
  if (!scope) throw new Error('GOVERNANCE_CONTEXT_REQUIRED');
  scope.principal = Object.freeze({ ...principal }); scope.revalidate = revalidate;
}
function current() { return scopes.getStore(); }
function principal() {
  const scope = current();
  if (!scope) return null; // Internal maintenance calls do not run in a user request.
  const actor = scope.revalidate ? scope.revalidate() : scope.principal;
  if (!actor?.subject) throw denied('PRINCIPAL_REQUIRED');
  return actor;
}
function canRead(resource, kind) {
  if (!current()) return true;
  const actor = principal(), policy = resource.governedPolicy || {};
  if (actor.channel === 'embed') return (policy.embedIds || []).includes(actor.embedId);
  if (actor.role === 'admin') return true;
  const type = kind==='sql'?'sql':kind==='document'?'documents':resource.dbName !== undefined || resource.database !== undefined || resource.host !== undefined ? 'sql' : 'documents';
  if (actor.permissions && !actor.permissions.includes(type==='sql'?'sql:read':'knowledge:read')) return false;
  if (actor.dataAccess?.[type] && !actor.dataAccess[type].includes(resource.id)) return false;
  if (policy.visibility !== 'restricted') return true;
  return (policy.subjects || []).includes(actor.subject) || (policy.roles || []).includes(actor.role);
}
function read(resource, type) {
  if (!canRead(resource,type)) {
    const error = denied('RESOURCE_ACCESS_DENIED');
    if (principal()?.channel === 'embed') {
      const name = resource.title || resource.name || resource.dbName || resource.database || resource.id;
      error.message = `Widget chưa được cấp quyền đọc nguồn ${type === 'sql' ? 'SQL' : 'tài liệu'} “${name}”. Quản trị viên cần thêm Embed ID vào “Widget được đọc” tại Quản trị dữ liệu → Quyền truy cập và xử lý dữ liệu.`;
    }
    throw error;
  }
  const scope = current();
  if (scope) scope.resources.set(`${type}:${resource.id}`, { resource, type });
  return resource;
}
function canSend(resource, providerId, local = false) {
  if (!canRead(resource)) return false;
  const policy = resource.governedPolicy || {};
  const sensitivity = policy.sensitivity || 'internal';
  const destinations = policy.modelDestinations || [];
  return sensitivity === 'public' || destinations.includes(providerId) || destinations.includes('*') || (local && sensitivity !== 'restricted');
}
function assertEgress(providerId, local = false) {
  const scope = current();
  if (!scope) return;
  principal();
  for (const { resource, type } of scope.resources.values()) {
    if (!canRead(resource)) throw denied('RESOURCE_ACCESS_REVOKED');
    const policy = resource.governedPolicy || {};
    const sensitivity = policy.sensitivity || 'internal';
    const destinations = policy.modelDestinations || [];
    if (sensitivity === 'public' || destinations.includes(providerId) || destinations.includes('*') || (local && sensitivity !== 'restricted')) continue;
    const name = resource.title || resource.name || resource.dbName || resource.database || resource.id;
    const error = denied('MODEL_DESTINATION_DENIED');
    error.message = `Nguồn ${type === 'sql' ? 'SQL' : 'tài liệu'} “${name}” chưa cho phép gửi dữ liệu tới đích “${providerId}”. Quản trị viên cần cấp đích xử lý cho đúng nguồn trong Quản trị dữ liệu → Quyền truy cập và xử lý dữ liệu.`;
    error.resourceId = resource.id; error.resourceType = type; error.destinationId = providerId;
    throw error;
  }
}
async function refresh(providerId, local = false) {
  if (!current()) return;
  const storage = require('../storage');
  const check = async () => {
    if (current().revalidateAsync) await current().revalidateAsync();
    principal();
    for (const [key, { resource, type }] of current().resources) {
      const latest = type === 'sql' ? require('../services/sql_connector').dbSources.find(item => item.id === resource.id)
        : require('../knowledge_core/services/library_service').documents.find(item => item.id === resource.id);
      if (!latest || !canRead(latest)) throw denied('RESOURCE_ACCESS_REVOKED');
      current().resources.set(key, { resource: latest, type });
    }
    if (providerId) assertEgress(providerId, local);
  };
  if (storage.enabled()) await storage.run(check, { independent: true, files: ['accounts.json', 'sessions.json', 'account_roles.json', 'db_sources.json', 'library.json', 'embed_chat_configs.json'] });
  else await check();
}
function summary() {
  const scope = current();
  return { scopeRef: scope?.principal?.subject || null,
    policyRevision: scope ? [...scope.resources.values()].map(({ resource, type }) => `${type}:${resource.id}:${resource.governedPolicy?.revision || 0}`).sort().join('|') || 'baseline/1' : null };
}
module.exports = { run, isolateResources, setPrincipal, current, principal, canRead, canSend, read, assertEgress, refresh, summary };
