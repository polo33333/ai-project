'use strict';
// Moves version 1 governance data to function groups and version 2 policies.
// Pure: takes plain copies of the stores and returns the next copies plus a
// report. Every (account × resource) read decision and every account's
// permission list must stay the same; only AI sharing may become wider.
const rules = require('./policy');
const ALL = ['dashboard.read','chat.use','schema.read','sources.read','library.read','glossary.read','workflows.use',
  'history.read','feedback.read','analytics.read','memory.use','sql:read','knowledge:read'];
const KIND = { sql: 'sql', document: 'documents' };

// Version 1 decision, as context.js and account_roles.js computed it before.
function oldEffective(account, roles) {
  const role = roles.find(item => item.id === (account.role || 'user'));
  if (account.role === 'admin') return { permissions: ALL, dataAccess: { sql: null, documents: null } };
  const permissions = account.permissions == null ? (role?.permissions || []) : account.permissions;
  const base = role?.dataAccess || {}, override = account.dataAccess || {};
  const dataAccess = Object.fromEntries(['sql', 'documents'].map(key => [key, base[key] == null ? (override[key] ?? null) : override[key] == null ? base[key] : override[key].filter(id => base[key].includes(id))]));
  return { permissions, dataAccess };
}
function oldCanRead(account, roles, resource, type) {
  if (account.role === 'admin') return true;
  const policy = resource.governedPolicy || {}, effective = oldEffective(account, roles), kind = KIND[type];
  if (!effective.permissions.includes(kind === 'sql' ? 'sql:read' : 'knowledge:read')) return false;
  if (effective.dataAccess?.[kind] && !effective.dataAccess[kind].includes(resource.id)) return false;
  if (policy.visibility !== 'restricted') return true;
  return (policy.subjects || []).includes(`account:${account.id}`) || (policy.roles || []).includes(account.role || 'user');
}
function newEffective(account, roles, groups) {
  if (account.role === 'admin') return { permissions: ALL, grants: null };
  const role = roles.find(item => item.id === (account.role || 'user'));
  const ids = [...(role?.functionGroups || []), ...(account.extraFunctionGroups || [])];
  const chosen = ids.map(id => groups.find(group => group.id === id)).filter(Boolean);
  const permissions = account.permissions != null ? account.permissions : [...new Set(chosen.flatMap(group => group.permissions))];
  const grants = { sql: [...new Set(chosen.flatMap(group => group.sources.sql))], documents: [...new Set(chosen.flatMap(group => group.sources.documents))] };
  return { permissions, grants, dataAccess: account.dataAccess || null };
}
function newCanRead(account, roles, groups, resource, type) {
  const effective = newEffective(account, roles, groups);
  return rules.canRead(resource, { subject: `account:${account.id}`, role: account.role || 'user', permissions: account.role === 'admin' ? undefined : effective.permissions,
    grants: effective.grants, dataAccess: effective.dataAccess }, type);
}

function migrate(input) {
  const data = structuredClone(input), report = { groupsCreated: [], rolesConverted: [], rolesCreated: [], accountsChanged: [], sourcesRestricted: [],
    denies: [], reviewAiSharing: [], keptWidgetGrants: [], blockedKeyColumns: [], openSources: [], mismatches: [] };
  const oldRoles = structuredClone(input.roles), oldAccounts = structuredClone(input.accounts), oldResources = structuredClone(input.resources);
  const systemRoles = [{ id: 'user', name: 'User — Người dùng', permissions: ALL, dataAccess: null }, { id: 'khach_widget', name: 'Khách widget', permissions: ['chat.use'], dataAccess: null }];
  const legacyRoles = [...systemRoles.filter(role => !data.roles.some(item => item.id === role.id && item.functionGroups)), ...data.roles.filter(role => !role.functionGroups && !systemRoles.some(item => item.id === role.id))];
  const allOldRoles = [...systemRoles, ...oldRoles.filter(role => !systemRoles.some(item => item.id === role.id))];
  const groupId = id => `${id.replace(/[^a-z0-9_-]/g, '_')}_chuyen_doi`.slice(0, 60);
  // 1. Each legacy role becomes one conversion function group with the same permissions.
  for (const role of legacyRoles) {
    const id = groupId(role.id);
    if (!data.groups.some(group => group.id === id)) {
      data.groups.push({ id, name: `${role.name} (chuyển đổi)`, description: 'Tạo khi chuyển sang nhóm chức năng.', permissions: [...(role.permissions || [])],
        sources: { sql: [], documents: [], watchfolders: [] }, packages: {}, workflows: [], revision: 1 });
      report.groupsCreated.push(id);
    }
    const stored = data.roles.find(item => item.id === role.id);
    if (stored) { delete stored.permissions; delete stored.dataAccess; stored.functionGroups = [id]; stored.revision = (stored.revision || 0) + 1; }
    else data.roles.push({ id: role.id, functionGroups: [id], revision: 1 });
    report.rolesConverted.push(role.id);
  }
  const groupOf = roleId => data.groups.find(group => group.id === groupId(roleId));
  // 2. Policies: version 2; role grants move into the role's conversion group.
  for (const { type, resource } of data.resources) {
    const raw = resource.governedPolicy;
    if (!raw || raw.schemaVersion === 2) continue;
    const next = rules.normalize(raw);
    for (const roleId of next.legacyRoles || []) groupOf(roleId)?.sources[KIND[type]].push(resource.id);
    delete next.legacyRoles;
    if (next.legacyEmbeds?.length) report.keptWidgetGrants.push({ type, id: resource.id, widgets: next.legacyEmbeds });
    if (raw.sensitivity === 'internal' && (raw.modelDestinations || []).length) report.reviewAiSharing.push({ type, id: resource.id, before: 'internal + đích riêng', after: 'all' });
    if (raw.sensitivity === 'restricted' && (raw.modelDestinations || []).length) report.reviewAiSharing.push({ type, id: resource.id, before: 'restricted + đích riêng', after: 'all' });
    const { revision, updatedBy, updatedAt, ...rest } = next;
    resource.governedPolicy = { ...rest, schemaVersion: 2, revision: (revision || 0) + 1, ...(updatedBy ? { updatedBy } : {}), ...(updatedAt ? { updatedAt } : {}) };
  }
  // 3. A role limited to some sources: the sources outside its list become "Theo nhóm chức năng"
  //    and every other role that could read them gets them in its conversion group.
  for (const role of allOldRoles) for (const [type, kind] of Object.entries(KIND)) {
    const list = role.dataAccess?.[kind];
    if (!Array.isArray(list)) continue;
    for (const { resource } of data.resources.filter(item => item.type === type && !list.includes(item.resource.id))) {
      const policy = rules.normalize(resource.governedPolicy);
      if (policy.access.mode === 'all') {
        resource.governedPolicy = { ...policy, schemaVersion: 2, access: { ...policy.access, mode: 'grants' }, revision: (policy.revision || 0) + 1 };
        report.sourcesRestricted.push({ type, id: resource.id });
        for (const other of allOldRoles) {
          const otherList = other.dataAccess?.[kind];
          if (other.id !== role.id && (!Array.isArray(otherList) || otherList.includes(resource.id))) {
            const group = groupOf(other.id); if (group && !group.sources[kind].includes(resource.id)) group.sources[kind].push(resource.id);
          }
        }
      }
    }
  }
  // 4. Accounts: wider permissions → an extra group; narrower → a role of their own.
  for (const account of data.accounts) {
    if (account.role === 'admin' || account.permissions == null) continue;
    const roleGroup = groupOf(account.role || 'user'), rolePermissions = roleGroup?.permissions || [];
    const narrower = rolePermissions.some(permission => !account.permissions.includes(permission));
    if (!narrower) {
      const id = `bo_sung_${String(account.id).replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 60);
      data.groups.push({ id, name: `Bổ sung: ${account.displayName || account.username}`, description: '', permissions: account.permissions.filter(permission => !rolePermissions.includes(permission)),
        sources: { sql: [], documents: [], watchfolders: [] }, packages: {}, workflows: [], revision: 1 });
      account.extraFunctionGroups = [...new Set([...(account.extraFunctionGroups || []), id])];
      report.groupsCreated.push(id);
    } else {
      const suffix = String(account.id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 30);
      const id = `rieng_${suffix}`, group = { id: `${id}_quyen`, name: `Quyền riêng: ${account.displayName || account.username}`, description: '', permissions: [...account.permissions],
        sources: structuredClone(roleGroup?.sources || { sql: [], documents: [], watchfolders: [] }), packages: {}, workflows: [], revision: 1 };
      data.groups.push(group); data.roles.push({ id, name: `Riêng: ${account.displayName || account.username}`, description: 'Tạo khi chuyển sang nhóm chức năng.', functionGroups: [group.id], revision: 1 });
      report.rolesCreated.push({ id, account: account.id }); account.role = id;
    }
    delete account.permissions; report.accountsChanged.push(account.id);
  }
  // 5. Compare every account and resource; patch what still differs with per-account grants or blocks.
  for (const account of oldAccounts) {
    const current = data.accounts.find(item => item.id === account.id);
    delete current.dataAccess;
    for (const { type, resource } of data.resources) {
      const before = oldCanRead(account, allOldRoles, oldResources.find(item => item.type === type && item.resource.id === resource.id).resource, type);
      const after = newCanRead(current, data.roles, data.groups, resource, type);
      if (before === after) continue;
      const policy = rules.normalize(resource.governedPolicy), subject = `account:${account.id}`;
      const access = before ? { ...policy.access, users: [...new Set([...policy.access.users, subject])] } : { ...policy.access, denyUsers: [...new Set([...policy.access.denyUsers, subject])] };
      resource.governedPolicy = { ...policy, schemaVersion: 2, access, revision: (policy.revision || 0) + 1 };
      report.denies.push({ account: account.id, type, id: resource.id, action: before ? 'grant' : 'deny' });
    }
  }
  // 6. Report only: sources without packages stay open (every table, as today) and blocked key columns.
  for (const { type, resource } of data.resources.filter(item => item.type === 'sql')) {
    const sql = rules.normalize(resource.governedPolicy).sql;
    if (!sql.packages.length) report.openSources.push(resource.id);
    const keys = new Set((data.tables || []).filter(table => table.dbSourceId === resource.id).flatMap(table => table.columns.filter(column => column.isPrimaryKey).map(column => column.columnName.toLowerCase())));
    const blockedKeys = sql.blockedColumns.filter(name => keys.has(name.split('.').pop().toLowerCase()));
    if (blockedKeys.length) report.blockedKeyColumns.push({ id: resource.id, columns: blockedKeys, type });
  }
  // 7. Verify: decisions and permission lists must match the version 1 data exactly.
  for (const account of oldAccounts) {
    const current = data.accounts.find(item => item.id === account.id);
    const beforePermissions = [...oldEffective(account, allOldRoles).permissions].sort().join(','), afterPermissions = [...newEffective(current, data.roles, data.groups).permissions].sort().join(',');
    if (beforePermissions !== afterPermissions) report.mismatches.push({ account: account.id, kind: 'permissions', before: beforePermissions, after: afterPermissions });
    for (const { type, resource } of data.resources) {
      const before = oldCanRead(account, allOldRoles, oldResources.find(item => item.type === type && item.resource.id === resource.id).resource, type);
      if (before !== newCanRead(current, data.roles, data.groups, resource, type)) report.mismatches.push({ account: account.id, kind: 'read', type, id: resource.id, before });
    }
  }
  return { data, report };
}
module.exports = { migrate, oldCanRead, newCanRead };
