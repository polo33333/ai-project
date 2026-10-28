'use strict';
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const rules = require('./policy');
const scopes = new AsyncLocalStorage();
const denied = code => Object.assign(new Error('Không có quyền truy cập tài nguyên hoặc đích xử lý.'), { code, statusCode: 403 });
// aiUsageAdmitted: account/model limits already passed in this request; the rest of the request is not cut off.
function run(operation) { return scopes.run({ principal: null, resources: new Map(), aiUsageAdmitted: new Set() }, operation); }
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
const label = (resource, type) => resource.title || resource.name || resource.dbName || resource.database || resource.path || resource.id;
const typeLabel = type => type === 'sql' ? 'SQL' : type === 'watchfolder' ? 'thư mục' : 'tài liệu';
function folders() {
  try { return require('../knowledge/services/watchfolder_service').folders || []; } catch { return []; }
}
function folderOf(document) {
  if (!document?.sourcePath) return null;
  const file = path.resolve(document.sourcePath).toLowerCase();
  return folders().find(folder => folder.path && file.startsWith(path.resolve(folder.path).toLowerCase() + path.sep)) || null;
}
// Effective policy: a document without its own policy (or marked to inherit)
// uses the policy of the watch folder it came from.
function policyFor(resource, type) {
  const kind = rules.kind(resource, type);
  if (kind === 'documents') {
    const own = resource.governedPolicy, folder = folderOf(resource);
    if (folder && (!own || own.inheritFrom)) {
      const inherited = rules.normalize(folder.governedPolicy);
      return { policy: { ...inherited, inheritFrom: `watchfolder:${folder.id}`, revision: `${own?.revision || 0}.${inherited.revision}` }, folderId: folder.id, folder };
    }
    return { policy: rules.normalize(own), folderId: folder?.id || null, folder };
  }
  return { policy: rules.normalize(resource.governedPolicy), folderId: null };
}
function explain(resource, kind, actor = current() ? principal() : null) {
  const { policy, folderId } = policyFor(resource, kind);
  return { ...rules.explain(resource, actor, kind, { policy, folderId }), policy, folderId };
}
function canRead(resource, kind) {
  if (!current()) return true;
  return explain(resource, kind).allowed;
}
function read(resource, type) {
  if (!canRead(resource,type)) {
    const error = denied('RESOURCE_ACCESS_DENIED');
    if (principal()?.channel === 'embed') {
      error.message = `Widget chưa được cấp quyền đọc nguồn ${typeLabel(type)} “${label(resource)}”. Quản trị viên cần gán cho widget một vai trò có quyền đọc nguồn này (Tài khoản → Vai trò và nhóm chức năng).`;
    }
    throw error;
  }
  const scope = current();
  if (scope) scope.resources.set(`${type}:${resource.id}`, { resource, type });
  return resource;
}
// Provider list: the egress check needs each provider's name and "Không nhận dữ liệu nội bộ" flag.
function target(destinationId, local) {
  return rules.destination(destinationId, local, require('../services/ai_provider_manager').providers || []);
}
const toolEgress = () => process.env.GOVERNED_TOOL_EGRESS !== 'off';
// True when AI may use the resource at all (aiSharing is not "off").
function aiUsable(resource, type) { return policyFor(resource, type).policy.aiSharing.level !== 'off'; }
function canSend(resource, providerId, local = false) {
  if (!canRead(resource)) return false;
  return rules.canSend(policyFor(resource).policy, target(providerId, local), { toolEgress: toolEgress() });
}
const LEVEL_LABEL = { all: 'Tất cả AI', local: 'Chỉ AI cục bộ', off: 'Tắt AI' };
function assertEgress(providerId, local = false) {
  const scope = current();
  if (!scope) return;
  principal();
  const destination = target(providerId, local);
  if (destination.kind === 'web') return;
  for (const { resource, type } of scope.resources.values()) {
    if (!canRead(resource, type)) throw denied('RESOURCE_ACCESS_REVOKED');
    const { policy } = policyFor(resource, type);
    if (rules.canSend(policy, destination, { toolEgress: toolEgress() })) continue;
    const error = denied('MODEL_DESTINATION_DENIED');
    error.message = destination.rejectInternalData
      ? `AI “${destination.name}” đang bật “Không nhận dữ liệu nội bộ”, nên không xử lý được nguồn ${typeLabel(type)} “${label(resource)}”. Hãy chọn AI khác hoặc đổi cấu hình tại AI Providers.`
      : `Nguồn ${typeLabel(type)} “${label(resource)}” đang đặt “${LEVEL_LABEL[policy.aiSharing.level]}”, nên không gửi được tới “${destination.name}”. Quản trị viên đổi tại Quản trị dữ liệu → Nguồn dữ liệu.`;
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
        : require('../knowledge/services/library_service').documents.find(item => item.id === resource.id);
      if (!latest || !canRead(latest, type)) throw denied('RESOURCE_ACCESS_REVOKED');
      current().resources.set(key, { resource: latest, type });
    }
    if (providerId) assertEgress(providerId, local);
  };
  if (storage.enabled()) await storage.run(check, { independent: true, files: ['accounts.json', 'sessions.json', 'account_roles.json', 'account_function_groups.json', 'db_sources.json', 'library.json', 'watchfolders.json', 'embed_chat_configs.json', 'ai_providers.json'] });
  else await check();
}
function summary() {
  const scope = current();
  return { scopeRef: scope?.principal?.subject || null,
    policyRevision: scope ? [...scope.resources.values()].map(({ resource, type }) => `${type}:${resource.id}:${policyFor(resource, type).policy.revision || 0}`)
      .concat(scope.principal?.accessRevision ? [`access:${scope.principal.accessRevision}`] : []).sort().join('|') || 'baseline/1' : null };
}
module.exports = { run, isolateResources, setPrincipal, current, principal, canRead, canSend, aiUsable, explain, policyFor, read, assertEgress, refresh, summary };
