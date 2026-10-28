'use strict';
const StorageHelper = require('../utils/storage_helper');
const FILE = 'training_resolutions.json';
function load() { const value = StorageHelper.loadJson(FILE, {}); return value && !Array.isArray(value) ? value : {}; }
function get(caseId) { return load()[caseId] || null; }
function set(caseId, resolved, actor = null) {
  if (!caseId || typeof caseId !== 'string' || caseId.length > 200) throw new Error('Case ID không hợp lệ.');
  const records = load();
  if (resolved) records[caseId] = { resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: actor || null };
  else delete records[caseId];
  StorageHelper.saveJson(FILE, records);
  return records[caseId] || { resolved: false, resolvedAt: null, resolvedBy: null };
}
module.exports = { get, set };
