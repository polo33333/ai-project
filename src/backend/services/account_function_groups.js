'use strict';
// Function groups: one business job each (permissions, sources, table packages,
// workflow packages). A role is the union of its function groups.
const StorageHelper = require('../utils/storage_helper');
const { higherLevel, PACKAGE_LEVELS } = require('../governance/policy');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const ids = (value, max = 500) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !id || id.length > 200)) fail('Danh sách mã không hợp lệ.');
  return [...new Set(value)];
};
function packages(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) fail('Gói bảng không hợp lệ.');
  return Object.fromEntries(Object.entries(value).map(([sourceId, grants]) => {
    if (!sourceId || typeof grants !== 'object' || Array.isArray(grants) || Object.values(grants).some(level => !PACKAGE_LEVELS.includes(level))) fail('Mức gói bảng chỉ gồm “full” hoặc “lookup”.');
    return [sourceId, { ...grants }];
  }).filter(([, grants]) => Object.keys(grants).length));
}
// Accounts are listed when the account store is configured (it always is outside tests).
function accountList() { try { return require('./auth_service').accounts; } catch { return []; } }
class AccountFunctionGroups {
  constructor() { StorageHelper.bind(this, 'groups', 'account_function_groups.json', []); }
  persist() { StorageHelper.saveJson('account_function_groups.json', this.groups); }
  list() { return this.groups; }
  get(id) { return this.groups.find(group => group.id === id); }
  validate(input) {
    const { validatePermissions } = require('./account_roles');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) fail('Tên nhóm chức năng phải có từ 1 đến 100 ký tự.');
    const sources = input.sources || {};
    return { name: input.name.trim(), description: String(input.description || '').slice(0, 400),
      permissions: validatePermissions(input.permissions || []),
      sources: { sql: ids(sources.sql), documents: ids(sources.documents), watchfolders: ids(sources.watchfolders) },
      packages: packages(input.packages), workflows: ids(input.workflows) };
  }
  save(input, id, actorId = null) {
    const existing = id && this.get(id);
    if (id && !existing) fail('Không tìm thấy nhóm chức năng.', 404);
    const key = id || input.id;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{1,59}$/.test(key)) fail('Mã nhóm chức năng gồm 2–60 ký tự chữ thường, số, gạch ngang hoặc gạch dưới.');
    if (!id && this.get(key)) fail('Mã nhóm chức năng đã tồn tại.', 409);
    if (existing && input.revision !== existing.revision) fail('Nhóm chức năng đã thay đổi. Hãy tải lại.', 409);
    const group = { id: key, ...this.validate(input), revision: (existing?.revision || 0) + 1, updatedBy: actorId, updatedAt: new Date().toISOString() };
    this.groups = existing ? this.groups.map(item => item.id === id ? group : item) : [...this.groups, group];
    this.persist(); return group;
  }
  remove(id, revision) {
    const existing = this.get(id);
    if (!existing) fail('Không tìm thấy nhóm chức năng.', 404);
    if (revision !== existing.revision) fail('Nhóm chức năng đã thay đổi. Hãy tải lại.', 409);
    const roles = require('./account_roles').list().filter(role => (role.functionGroups || []).includes(id));
    const accounts = accountList().filter(account => (account.extraFunctionGroups || []).includes(id));
    if (roles.length || accounts.length) fail(`Nhóm chức năng đang được dùng bởi ${roles.length} vai trò và ${accounts.length} tài khoản.`, 409);
    this.groups = this.groups.filter(item => item.id !== id); this.persist(); return true;
  }
  // Union of the given groups. Two groups granting one package keep the higher level.
  combine(groupIds) {
    const result = { permissions: new Set(), sql: new Set(), documents: new Set(), watchfolders: new Set(), workflows: new Set(), packages: {}, revisions: [] };
    for (const id of groupIds || []) {
      const group = this.get(id);
      if (!group) continue;
      result.revisions.push(`${group.id}:${group.revision}`);
      group.permissions.forEach(item => result.permissions.add(item));
      for (const type of ['sql', 'documents', 'watchfolders']) (group.sources?.[type] || []).forEach(item => result[type].add(item));
      (group.workflows || []).forEach(item => result.workflows.add(item));
      for (const [sourceId, grants] of Object.entries(group.packages || {})) {
        const target = result.packages[sourceId] ||= {};
        for (const [packageId, level] of Object.entries(grants)) target[packageId] = higherLevel(target[packageId], level);
      }
    }
    return result;
  }
  // Roles and accounts that use a group, for the impact shown before saving.
  impact(id) {
    const roles = require('./account_roles').list().filter(role => (role.functionGroups || []).includes(id));
    const roleIds = new Set(roles.map(role => role.id));
    const accounts = accountList().filter(account => roleIds.has(account.role || 'user') || (account.extraFunctionGroups || []).includes(id));
    return { roles: roles.map(role => ({ id: role.id, name: role.name })), accounts: accounts.length, accountIds: accounts.map(account => account.id) };
  }
}
module.exports = new AccountFunctionGroups();
