'use strict';
const Ajv = require('ajv');
const rules = require('./policy');
const ajv = new Ajv({ strict: false });
const strings = (max = 100) => ({ type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, maxItems: max });
// Version 1 body, still accepted for one release and stored as version 2.
const validateV1 = ajv.compile({ type: 'object', additionalProperties: false,
  properties: { visibility: { enum: ['shared', 'restricted'] }, sensitivity: { enum: ['public', 'internal', 'restricted'] },
    subjects: strings(), roles: { type: 'array', items: { type: 'string', minLength:1, maxLength:40 } }, embedIds: strings(),
    modelDestinations: strings(), allowedTables: strings(), blockedColumns: strings() },
  required: ['visibility', 'sensitivity', 'subjects', 'roles', 'embedIds', 'modelDestinations'] });
const validateV2 = ajv.compile({ type: 'object', additionalProperties: false, required: ['schemaVersion', 'access', 'aiSharing'],
  properties: { schemaVersion: { const: 2 },
    access: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: rules.ACCESS_MODES }, users: strings(200), denyUsers: strings(200) } },
    aiSharing: { type: 'object', additionalProperties: false, required: ['level'], properties: { level: { enum: rules.AI_LEVELS }, excludeDestinations: strings() } },
    sql: { type: 'object', additionalProperties: false, properties: { allowedTables: strings(500), blockedColumns: strings(500), hiddenTables: strings(500),
      rowRules: { type: 'array', maxItems: 100 },
      packages: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'name', 'tables'], properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,59}$' }, name: { type: 'string', minLength: 1, maxLength: 100 }, tables: strings(500),
        sensitiveColumns: strings(500), lookupColumns: strings(200), allowBridge: { type: 'boolean' }, base: { type: 'boolean' }, baseLevel: { enum: rules.PACKAGE_LEVELS } } } } } },
    inheritFrom: { type: ['string', 'null'] } } });
const fail = (message, statusCode = 400, extra = {}) => { throw Object.assign(new Error(message), { statusCode, ...extra }); };
const TYPE_KIND = { sql: 'sql', document: 'documents', watchfolder: 'watchfolders' };
// Loaded on first use: some services need configuration that a route may not touch.
const services = () => ({ get library() { return require('../knowledge/services/library_service'); }, get sql() { return require('../services/sql_connector'); },
  get folders() { return require('../knowledge/services/watchfolder_service'); }, get dictionary() { return require('../services/dictionary_service'); },
  get groups() { return require('../services/account_function_groups'); }, get roles() { return require('../services/account_roles'); },
  get auth() { return require('../services/auth_service'); }, get providers() { return require('../services/ai_provider_manager'); },
  get embeds() { return require('../services/embed_chat_service'); } });
function resources() {
  const { library, sql, folders } = services();
  return [...sql.dbSources.map(resource => ({ type: 'sql', resource })), ...library.documents.map(resource => ({ type: 'document', resource })),
    ...(folders.folders || []).map(resource => ({ type: 'watchfolder', resource }))];
}
const persist = type => { const s = services(); (type === 'sql' ? s.sql : type === 'document' ? s.library : s.folders).persist(); };
const nameOf = resource => resource.title || resource.name || resource.dbName || resource.database || resource.path || resource.id;
function view({ type, resource }) {
  const context = require('./context'), { groups, dictionary } = services();
  const { policy, folderId } = context.policyFor(resource, type);
  const own = resource.governedPolicy ? rules.normalize(resource.governedPolicy) : null;
  const kind = TYPE_KIND[type];
  return { type, id: resource.id, name: nameOf(resource), policy, revision: resource.governedPolicy?.revision || 0,
    inherited: type === 'document' && Boolean(folderId) && (!own || Boolean(own.inheritFrom)), folderId,
    functionGroups: groups.list().filter(group => (group.sources?.[kind] || []).includes(resource.id)).map(group => group.id),
    legacy: Boolean(policy.legacyRoles?.length || policy.legacyEmbeds?.length),
    ...(type === 'sql' ? { tableCount: dictionary.tablesStore.filter(table => table.dbSourceId === resource.id && table.isActive !== false).length, ...orphanTables(resource, policy) } : {}),
    ...(type === 'document' ? { sourcePath: Boolean(resource.sourcePath) } : {}) };
}
// Accounts are listed when the account store is configured (it always is outside tests).
function accountList() { try { return services().auth.accounts; } catch { return []; } }
// Tables of a packaged source that belong to no package (and are not hidden): only admin can query them.
function orphanTables(source, policy) {
  if (!policy.sql.packages.length) return {};
  const key = require('./scope').key, listed = new Set([...policy.sql.packages.flatMap(item => item.tables), ...policy.sql.hiddenTables].map(key));
  const orphans = services().dictionary.tablesStore.filter(table => table.dbSourceId === source.id && ![key(table.tableId), key(table.tableName), key(`${table.schemaName || 'dbo'}.${table.tableName}`)].some(name => listed.has(name)));
  return { orphanTables: orphans.map(table => ({ name: `${table.schemaName || 'dbo'}.${table.tableName}`, active: table.isActive !== false })) };
}
function catalogs() {
  const { groups, roles, providers, embeds, folders } = services();
  return { providers: (providers.providers || []).map(provider => ({ id: provider.id, name: provider.name, model: provider.model, isActive: provider.isActive === true,
      local: provider.executionClass === 'local' || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(provider.baseUrl || ''), rejectInternalData: provider.rejectInternalData === true })),
    functionGroups: groups.list().map(group => ({ id: group.id, name: group.name })),
    roles: roles.list().map(role => ({ id: role.id, name: role.name, builtin: role.builtin, functionGroups: role.functionGroups || null })),
    users: accountList().map(account => ({ id: `account:${account.id}`, name: account.displayName || account.username, role: account.role || 'user', isActive: account.isActive !== false })),
    embeds: (embeds.configs || []).map(config => ({ id: config.id, name: config.name, role: config.role || 'khach_widget' })),
    watchfolders: (folders.folders || []).map(folder => ({ id: folder.id, name: folder.path })) };
}
// Tables of one source for the package editor: names, columns and keys only.
function sourceTables(sourceId) {
  const { dictionary } = services(), key = require('./scope').key;
  const relations = (dictionary.tableRelationships || []).filter(relation => relation.isActive !== false && relation.status === 'verified' && String(relation.sourceTableId || '').startsWith(`${key(sourceId)}::`));
  const keys = new Map();
  for (const relation of relations) for (const pair of relation.columnPairs || []) {
    (keys.get(relation.sourceTableId) || keys.set(relation.sourceTableId, new Set()).get(relation.sourceTableId)).add(pair.sourceColumn);
    (keys.get(relation.targetTableId) || keys.set(relation.targetTableId, new Set()).get(relation.targetTableId)).add(pair.targetColumn);
  }
  // Inactive tables are listed too, so a table switched on later already has its package.
  return dictionary.tablesStore.filter(table => table.dbSourceId === sourceId).map(table => ({ id: table.tableId, name: `${table.schemaName || 'dbo'}.${table.tableName}`, active: table.isActive !== false,
    description: String(table.tableDescription || '').split(/[.\n]/)[0].slice(0, 120),
    columns: table.columns.map(column => ({ name: column.columnName, key: Boolean(column.isPrimaryKey) || keys.get(table.tableId)?.has(column.columnName) === true })) }));
}
function validatePolicy(type, resource, input) {
  let policy;
  if (input?.schemaVersion === 2) { if (!validateV2(input)) fail('Chính sách không đúng schema.'); policy = rules.normalize(input); }
  else { if (!validateV1(input)) fail('Chính sách không đúng schema.'); if (input.roles.some(id => !services().roles.get(id))) fail('Vai trò không tồn tại.'); policy = rules.normalize(input); }
  const accounts = input.schemaVersion === 2 && [...policy.access.users, ...policy.access.denyUsers].length ? new Set(accountList().map(account => `account:${account.id}`)) : null;
  if (accounts && [...policy.access.users, ...policy.access.denyUsers].some(subject => !accounts.has(subject))) fail('Tài khoản không tồn tại.');
  if (type !== 'sql') policy.sql = rules.defaults().sql;
  else validatePackages(resource, policy.sql);
  return policy;
}
// A table belongs to at most one package; hidden tables are in none; keys cannot be sensitive (Q3).
function validatePackages(source, sql) {
  if (!sql.packages.length) return;
  const key = require('./scope').key, tables = sourceTables(source.id);
  const find = name => tables.find(table => [key(table.id), key(table.name), key(table.name.split('.').pop())].includes(key(name)));
  const ids = new Set(), owner = new Map(), hidden = new Set(sql.hiddenTables.map(name => find(name)?.id).filter(Boolean));
  for (const item of sql.packages) {
    if (ids.has(item.id)) fail(`Mã gói “${item.id}” bị trùng.`); ids.add(item.id);
    for (const name of item.tables) {
      const table = find(name);
      if (!table) fail(`Bảng “${name}” không có trong danh mục lược đồ của nguồn.`);
      if (hidden.has(table.id)) fail(`Bảng “${table.name}” đang ẩn nên không thể thuộc gói.`);
      if (owner.has(table.id)) fail(`Bảng “${table.name}” thuộc cả gói “${owner.get(table.id)}” và “${item.name}”.`);
      owner.set(table.id, item.name);
    }
    for (const entry of item.sensitiveColumns) {
      const parts = entry.split('.'), column = parts.pop(), tableName = parts.join('.');
      const candidates = tableName ? [find(tableName)].filter(Boolean) : item.tables.map(find).filter(Boolean);
      if (candidates.some(table => table.columns.some(col => key(col.name) === key(column) && col.key))) fail(`Cột “${entry}” là khóa nối nên không thể đánh dấu nhạy cảm.`);
    }
  }
}
function setMembership(type, id, groupIds, actorId) {
  const { groups } = services(), kind = TYPE_KIND[type];
  if (!Array.isArray(groupIds)) return;
  if (groupIds.some(groupId => !groups.get(groupId))) fail('Nhóm chức năng không tồn tại.');
  for (const group of groups.list()) {
    const has = (group.sources?.[kind] || []).includes(id), want = groupIds.includes(group.id);
    if (has === want) continue;
    const sources = { ...group.sources, [kind]: want ? [...(group.sources?.[kind] || []), id] : group.sources[kind].filter(item => item !== id) };
    groups.save({ ...group, sources }, group.id, actorId);
  }
}
function store(item, policy, account, previous, dropLegacy = false) {
  const keep = dropLegacy ? {} : { ...(previous?.legacyRoles?.length ? { legacyRoles: previous.legacyRoles } : {}), ...(previous?.legacyEmbeds?.length ? { legacyEmbeds: previous.legacyEmbeds } : {}) };
  const { revision: _r, updatedBy: _u, updatedAt: _a, legacyRoles: _l, legacyEmbeds: _e, ...rest } = policy;
  item.resource.governedPolicy = { ...rest, ...keep, schemaVersion: 2, inheritFrom: null,
    revision: (item.resource.governedPolicy?.revision || 0) + 1, updatedBy: account.id, updatedAt: new Date().toISOString() };
}
// Actor for the "Kiểm tra quyền" tab: an account, a role or a widget.
function actorFor(query) {
  const { roles, embeds } = services();
  if (query.subject) {
    const auth = services().auth, account = auth.accounts.find(item => `account:${item.id}` === query.subject);
    if (!account) fail('Không tìm thấy tài khoản.', 404);
    const effective = auth.publicAccount(account);
    return { subject: query.subject, role: effective.role, permissions: effective.role === 'admin' ? undefined : effective.permissions, dataAccess: effective.dataAccess,
      grants: effective.grants, functionGroups: effective.functionGroups, accessRevision: effective.accessRevision, channel: 'chat', label: account.displayName || account.username };
  }
  if (query.role) {
    const role = roles.get(query.role); if (!role) fail('Không tìm thấy vai trò.', 404);
    const effective = roles.effective({ role: role.id });
    return { subject: `role:${role.id}`, role: role.id, permissions: role.id === 'admin' ? undefined : effective.permissions, dataAccess: effective.dataAccess,
      grants: effective.grants, functionGroups: effective.functionGroups, accessRevision: effective.accessRevision, channel: 'chat', label: role.name };
  }
  if (query.embed) {
    const config = (embeds.configs || []).find(item => item.id === query.embed); if (!config) fail('Không tìm thấy widget.', 404);
    const widget = roles.forEmbed(config);
    return { subject: `embed:${config.id}:inspect`, channel: 'embed', embedId: config.id, ...widget, functionGroups: roles.effective({ role: widget.role }).functionGroups, label: config.name };
  }
  fail('Cần chọn tài khoản, vai trò hoặc widget.');
}
function effectiveReport(actor) {
  const context = require('./context'), scopes = require('./scope'), { groups, providers } = services();
  const active = (providers.providers || []).filter(provider => provider.isActive || provider.status !== 'unconfigured');
  const viaGroups = (kind, id) => (actor.functionGroups || []).filter(groupId => (groups.get(groupId)?.sources?.[kind] || []).includes(id)).map(groupId => groups.get(groupId).name);
  const items = resources().filter(item => item.type !== 'watchfolder').map(item => {
    const decision = context.explain(item.resource, item.type, actor), kind = TYPE_KIND[item.type];
    const ai = active.map(provider => {
      const target = rules.destination(provider.id, provider.executionClass === 'local' || /localhost|127\.0\.0\.1/.test(provider.baseUrl || ''), providers.providers);
      return { id: provider.id, name: provider.name, allowed: decision.allowed && rules.canSend(decision.policy, target) };
    });
    const result = { type: item.type, id: item.resource.id, name: nameOf(item.resource), allowed: decision.allowed, reason: decision.reason,
      via: decision.reason === 'GRANT_FUNCTION_GROUP' ? viaGroups(kind, item.resource.id) : [], aiLevel: decision.policy.aiSharing.level, ai };
    if (item.type === 'sql' && decision.allowed) {
      const scope = scopes.effectiveScope(item.resource, actor.role === 'admin' ? null : actor);
      result.open = scope.open;
      result.tables = [...scope.entries.values()].map(entry => ({ name: `${entry.table.schemaName || 'dbo'}.${entry.table.tableName}`, level: entry.level, packageName: entry.packageName, via: entry.via }))
        .sort((a, b) => ['full', 'lookup', 'bridge'].indexOf(a.level) - ['full', 'lookup', 'bridge'].indexOf(b.level) || a.name.localeCompare(b.name));
    }
    return result;
  });
  return { actor: { subject: actor.subject, label: actor.label, role: actor.role, permissions: actor.permissions || null, functionGroups: (actor.functionGroups || []).map(id => ({ id, name: groups.get(id)?.name || id })),
    workflows: actor.grants?.workflows || [] }, resources: items };
}
// Coverage check (kiểm tra độ phủ) for every non-admin role, optionally with draft groups.
function coverage(sourceId, draftGroups) {
  const scopes = require('./scope'), { sql, roles, groups, dictionary } = services(), key = scopes.key;
  const source = sql.dbSources.find(item => item.id === sourceId); if (!source) fail('Không tìm thấy nguồn SQL.', 404);
  const policy = rules.normalize(source.governedPolicy);
  const original = groups.groups;
  if (Array.isArray(draftGroups)) groups.groups = original.map(group => draftGroups.find(draft => draft.id === group.id) ? { ...group, ...draftGroups.find(draft => draft.id === group.id) } : group);
  try {
    const tables = dictionary.tablesStore.filter(table => table.dbSourceId === sourceId && table.isActive !== false);
    const byId = new Map(tables.map(table => [table.tableId, table]));
    const relations = (dictionary.tableRelationships || []).filter(relation => relation.isActive !== false && relation.status === 'verified' && byId.has(relation.sourceTableId) && byId.has(relation.targetTableId));
    const label = table => `${table.schemaName || 'dbo'}.${table.tableName}`;
    const inPackage = new Set(policy.sql.packages.flatMap(item => item.tables.map(key)));
    const hidden = new Set(policy.sql.hiddenTables.map(key));
    const named = table => [key(table.tableId), key(table.tableName), key(label(table))];
    const orphans = policy.sql.packages.length ? tables.filter(table => !named(table).some(name => inPackage.has(name) || hidden.has(name))).map(label) : [];
    const noJoin = policy.sql.packages.flatMap(item => {
      const members = tables.filter(table => named(table).some(name => item.tables.map(key).includes(name)));
      if (members.length < 2) return [];
      return members.filter(table => !relations.some(relation => (relation.sourceTableId === table.tableId && members.some(other => other.tableId === relation.targetTableId))
        || (relation.targetTableId === table.tableId && members.some(other => other.tableId === relation.sourceTableId)))).map(table => ({ packageName: item.name, table: label(table) }));
    });
    const report = roles.list().filter(role => role.id !== 'admin').map(role => {
      const effective = roles.effective({ role: role.id });
      const actor = { subject: `role:${role.id}`, role: role.id, permissions: effective.permissions, grants: effective.grants, accessRevision: `draft:${Date.now()}` };
      if (!effective.permissions.includes('sql:read')) return { role: role.id, name: role.name, sqlRead: false, tables: 0, codeOnly: [], metrics: 0 };
      const scope = scopes.effectiveScope(source, actor);
      const codeOnly = [];
      for (const relation of relations) {
        const from = scope.entries.get(relation.sourceTableId);
        if (!from || from.level === 'bridge' || !['many-to-one', 'one-to-one'].includes(relation.cardinality || relation.relationType)) continue;
        const target = scope.entries.get(relation.targetTableId);
        if (!target || target.level === 'bridge' || !relation.displayColumn) codeOnly.push({ from: label(from.table), to: label(byId.get(relation.targetTableId)), reason: !target || target.level === 'bridge' ? 'TARGET_OUT_OF_SCOPE' : 'NO_DISPLAY_COLUMN' });
      }
      const readable = [...scope.entries.values()].filter(entry => entry.level !== 'bridge');
      return { role: role.id, name: role.name, sqlRead: true, tables: readable.length, full: readable.filter(entry => entry.level === 'full').length, codeOnly: codeOnly.slice(0, 50),
        metrics: (source.governedMetrics || []).filter(metric => metric.approved).length };
    });
    return { sourceId, packages: policy.sql.packages.length, orphans, noJoin: noJoin.slice(0, 100), relations: relations.length, roles: report };
  } finally { groups.groups = original; }
}
// Draft packages grouped by table-name prefix; tables that look like secrets are suggested as hidden.
function suggestPackages(sourceId) {
  const tables = sourceTables(sourceId), groups = new Map(), hidden = [];
  for (const table of tables) {
    const short = table.name.split('.').pop();
    if (/otp|token|password|passwd|secret|session|fcm|esign/i.test(short)) { hidden.push(table.name); continue; }
    const prefix = (/^([A-Za-z]+)_/.exec(short)?.[1] || 'khac').toLowerCase();
    (groups.get(prefix) || groups.set(prefix, []).get(prefix)).push(table.name);
  }
  return { packages: [...groups].map(([prefix, names]) => ({ id: prefix, name: prefix === 'khac' ? 'Khác' : `Nhóm ${prefix.toUpperCase()}_`, tables: names, sensitiveColumns: [], allowBridge: true, base: false })), hiddenTables: hidden };
}
// Published packages only: a draft reaches no one, and a newly published package stays off until a group turns it on.
async function workflowPackages() {
  try {
    const automation = require('../automation'); await automation.settings();
    return (await automation.repository.list('catalog')).filter(record => record.published && record.id !== '_settings')
      .map(record => ({ id: record.id, name: record.published.manifest?.name || record.id, enabled: record.enabled !== false }));
  } catch { return []; }
}
async function handle(req, res, pathname, account, readBody) {
  if (!pathname.startsWith('/api/governance/')) return false;
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (account?.role !== 'admin') { send(403, { message: 'Cần quyền quản trị.' }); return true; }
  try {
    if (pathname === '/api/governance/operations') {
      if (req.method !== 'GET') fail('Method not allowed', 405);
      try {
        const operations = require('./operations');
        send(200, operations.summarize(await operations.loadAudits(), operations.readPolicy()));
      } catch (error) { send(400, { code: error.code || 'OPERATIONS_REPORT_FAILED', message: 'Không thể tạo báo cáo vận hành. Kiểm tra cấu hình chính sách.' }); }
      return true;
    }
    const { sql, groups } = services();
    if (pathname === '/api/governance/metrics') {
      const metrics = require('./metrics');
      if (req.method === 'GET') { send(200, { metrics: sql.dbSources.flatMap(source => (source.governedMetrics || []).map(metric => ({ ...metric, sourceId: source.id }))) }); return true; }
      if (req.method === 'PUT') { const body = await readBody(req); send(200, { metric: metrics.save(body.sourceId, body.definition, body.expectedRevision) }); return true; }
      fail('Method not allowed', 405);
    }
    if (pathname === '/api/governance/resources') {
      if (req.method === 'GET') {
        const policy = require('../automation/read_only_policy');
        send(200, { readOnly: policy.enabled(), externalReadOnly: policy.externalReadOnly(), toolEgress: process.env.GOVERNED_TOOL_EGRESS !== 'off',
          resources: resources().map(view), ...catalogs() });
        return true;
      }
      if (req.method !== 'PUT') fail('Method not allowed', 405);
      const body = await readBody(req), item = resources().find(entry => entry.type === body.type && entry.resource.id === body.id);
      if (!item) fail('Không tìm thấy tài nguyên.', 404);
      const revision = item.resource.governedPolicy?.revision || 0;
      if (body.expectedRevision !== revision) fail('Chính sách đã thay đổi. Hãy tải lại.', 409);
      if (body.type === 'document' && body.inherit === true) {
        if (!require('./context').policyFor(item.resource, 'document').folderId) fail('Tài liệu không thuộc thư mục theo dõi nào.');
        item.resource.governedPolicy = { schemaVersion: 2, inheritFrom: 'watchfolder', revision: revision + 1, updatedBy: account.id, updatedAt: new Date().toISOString() };
      } else store(item, validatePolicy(body.type, item.resource, body.policy), account, rules.normalize(item.resource.governedPolicy), body.dropLegacy === true);
      setMembership(body.type, body.id, body.functionGroups, account.id);
      persist(body.type);
      send(200, { resource: view(item) }); return true;
    }
    if (pathname === '/api/governance/resources/bulk') {
      if (req.method !== 'POST') fail('Method not allowed', 405);
      const body = await readBody(req), all = resources();
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) fail('Cần chọn từ 1 đến 500 nguồn.');
      const patch = body.patch || {};
      if (patch.access && !rules.ACCESS_MODES.includes(patch.access.mode)) fail('Chế độ mở không hợp lệ.');
      if (patch.aiSharing && !rules.AI_LEVELS.includes(patch.aiSharing.level)) fail('Mức chia sẻ AI không hợp lệ.');
      if (!patch.access && !patch.aiSharing) fail('Chưa có thay đổi nào.');
      const targets = body.items.map(entry => ({ entry, item: all.find(candidate => candidate.type === entry.type && candidate.resource.id === entry.id) }));
      const missing = targets.filter(target => !target.item), conflicts = targets.filter(target => target.item && (target.item.resource.governedPolicy?.revision || 0) !== target.entry.expectedRevision);
      if (missing.length) fail('Có nguồn không còn tồn tại.', 404, { items: missing.map(target => target.entry) });
      if (conflicts.length) fail('Có nguồn đã bị thay đổi. Hãy tải lại.', 409, { conflicts: conflicts.map(target => ({ type: target.entry.type, id: target.entry.id, name: nameOf(target.item.resource) })) });
      const context = require('./context'), touched = new Set();
      for (const { item } of targets) {
        const current = context.policyFor(item.resource, item.type).policy;
        const next = { ...current, access: patch.access ? { ...current.access, mode: patch.access.mode } : current.access,
          aiSharing: patch.aiSharing ? { ...current.aiSharing, level: patch.aiSharing.level } : current.aiSharing };
        store(item, next, account, rules.normalize(item.resource.governedPolicy)); touched.add(item.type);
      }
      touched.forEach(persist);
      send(200, { resources: targets.map(target => view(target.item)) }); return true;
    }
    if (pathname === '/api/governance/effective') {
      if (req.method !== 'GET') fail('Method not allowed', 405);
      const query = Object.fromEntries(new URL(req.url || pathname, 'http://localhost').searchParams);
      send(200, effectiveReport(actorFor(query))); return true;
    }
    if (pathname === '/api/governance/coverage') {
      if (req.method !== 'POST') fail('Method not allowed', 405);
      const body = await readBody(req); send(200, coverage(body.sourceId, body.groups)); return true;
    }
    const sqlRoute = pathname.match(/^\/api\/governance\/sql\/([^/]+)\/(tables|package-suggestions|check-query)$/);
    if (sqlRoute) {
      const sourceId = decodeURIComponent(sqlRoute[1]), source = sql.dbSources.find(item => item.id === sourceId);
      if (!source) fail('Không tìm thấy nguồn SQL.', 404);
      if (sqlRoute[2] === 'tables' && req.method === 'GET') { send(200, { tables: sourceTables(sourceId) }); return true; }
      if (sqlRoute[2] === 'package-suggestions' && req.method === 'GET') { send(200, suggestPackages(sourceId)); return true; }
      if (sqlRoute[2] === 'check-query' && req.method === 'POST') {
        const body = await readBody(req), actor = actorFor(body);
        if (typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 20000) fail('Câu SQL không hợp lệ.');
        const context = require('./context');
        const result = await context.run(async () => {
          context.setPrincipal(actor);
          try { return { allowed: true, sql: require('./sql_policy').check(body.sql, source) }; }
          catch (error) { return { allowed: false, code: error.code || 'SQL_DENIED', message: error.message }; }
        });
        send(200, result); return true;
      }
      fail('Method not allowed', 405);
    }
    if (pathname === '/api/governance/function-groups') {
      if (req.method === 'GET') {
        const { roles, folders, library } = services();
        send(200, { groups: groups.list().map(group => ({ ...group, impact: groups.impact(group.id) })), roles: roles.list(), capabilities: roles.capabilities,
          catalog: { sql: sql.dbSources.map(source => ({ id: source.id, name: nameOf(source), mode: rules.normalize(source.governedPolicy).access.mode, packages: rules.normalize(source.governedPolicy).sql.packages.map(item => ({ id: item.id, name: item.name, tables: item.tables.length, base: item.base })) })),
            documents: library.documents.map(document => ({ id: document.id, name: nameOf(document), mode: require('./context').policyFor(document, 'document').policy.access.mode })),
            watchfolders: (folders.folders || []).map(folder => ({ id: folder.id, name: folder.path, mode: rules.normalize(folder.governedPolicy).access.mode })),
            workflows: await workflowPackages() } });
        return true;
      }
      if (req.method === 'POST') { const body = await readBody(req); send(201, { group: groups.save(body, null, account.id) }); return true; }
      fail('Method not allowed', 405);
    }
    if (pathname === '/api/governance/function-groups/matrix') {
      if (req.method !== 'POST') fail('Method not allowed', 405);
      const body = await readBody(req);
      if (!Array.isArray(body.cells) || body.cells.length > 2000) fail('Ma trận không hợp lệ.');
      const source = sql.dbSources.find(item => item.id === body.sourceId); if (!source) fail('Không tìm thấy nguồn SQL.', 404);
      const packages = new Set(rules.normalize(source.governedPolicy).sql.packages.map(item => item.id));
      const changed = new Map();
      for (const cell of body.cells) {
        const group = groups.get(cell.groupId); if (!group) fail('Nhóm chức năng không tồn tại.');
        if (!packages.has(cell.packageId)) fail('Gói bảng không tồn tại.');
        if (cell.level !== null && !rules.PACKAGE_LEVELS.includes(cell.level)) fail('Mức gói bảng không hợp lệ.');
        if (body.revisions?.[group.id] !== group.revision) fail(`Nhóm chức năng “${group.name}” đã thay đổi. Hãy tải lại.`, 409);
        const next = changed.get(group.id) || structuredClone(group);
        const grants = { ...(next.packages?.[source.id] || {}) };
        if (cell.level) grants[cell.packageId] = cell.level; else delete grants[cell.packageId];
        next.packages = { ...(next.packages || {}), [source.id]: grants };
        changed.set(group.id, next);
      }
      const saved = [...changed.values()].map(group => groups.save(group, group.id, account.id));
      send(200, { groups: saved }); return true;
    }
    const groupRoute = pathname.match(/^\/api\/governance\/function-groups\/([^/]+)$/);
    if (groupRoute) {
      const id = decodeURIComponent(groupRoute[1]);
      if (req.method === 'PUT') { const body = await readBody(req); send(200, { group: groups.save(body, id, account.id), impact: groups.impact(id) }); return true; }
      if (req.method === 'DELETE') { const revision = Number(new URL(req.url || pathname, 'http://localhost').searchParams.get('revision')); groups.remove(id, revision); send(200, { deleted: true }); return true; }
      fail('Method not allowed', 405);
    }
    send(404, { message: 'Không tìm thấy.' }); return true;
  } catch (error) {
    send(error.statusCode || 400, { message: error.message, code: error.code, ...(error.conflicts ? { conflicts: error.conflicts } : {}), ...(error.items ? { items: error.items } : {}) });
    return true;
  }
}
module.exports = { handle, coverage, suggestPackages, effectiveReport, actorFor };
