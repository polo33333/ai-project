'use strict';

const StorageHelper = require('../utils/storage_helper');

const DOMAIN_ALIASES_FILE = 'domain_aliases.json';

function normalizeDomainAliases(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.fromEntries(Object.entries(value)
    .map(([domain, aliases]) => [
      String(domain || '').trim(),
      Array.isArray(aliases)
        ? [...new Set(aliases.map(alias => String(alias || '').trim()).filter(Boolean))]
        : []
    ])
    .filter(([domain]) => domain));
}

function getDomainAliases() {
  // Đọc lại mỗi lần chọn schema để có thể chỉnh file mà không phải sửa code.
  return normalizeDomainAliases(StorageHelper.loadJson(DOMAIN_ALIASES_FILE, {}));
}

function normalizeDomainKey(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function saveDomainAliases(aliases) {
  const normalized = normalizeDomainAliases(aliases);
  StorageHelper.saveJson(DOMAIN_ALIASES_FILE, normalized);
  return normalized;
}

function upsertDomainAlias({ oldDomain, domain, aliases }) {
  const key = normalizeDomainKey(domain);
  if (!key) throw new Error('Mã nghiệp vụ không hợp lệ.');
  const current = getDomainAliases();
  const oldKey = normalizeDomainKey(oldDomain);
  if (oldKey && oldKey !== key) delete current[oldKey];
  current[key] = Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,;\n|]+/);
  return saveDomainAliases(current);
}

function deleteDomainAlias(domain) {
  const key = normalizeDomainKey(domain);
  const current = getDomainAliases();
  if (!key || !Object.prototype.hasOwnProperty.call(current, key)) return null;
  delete current[key];
  return saveDomainAliases(current);
}

module.exports = {
  DOMAIN_ALIASES_FILE,
  getDomainAliases,
  normalizeDomainAliases,
  normalizeDomainKey,
  upsertDomainAlias,
  deleteDomainAlias
};
