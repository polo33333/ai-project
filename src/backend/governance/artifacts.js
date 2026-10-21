'use strict';
const fs = require('node:fs');
const path = require('node:path');
const governance = require('./context');
function metadataPath(filename) {
  if (!filename || path.basename(filename) !== filename || !/\.(?:xlsx|csv|pdf|html)$/i.test(filename)) throw Object.assign(new Error('Tên file không hợp lệ.'), { statusCode: 400 });
  return path.join(require('../utils/export_paths').getExportsDirectory(), `.${filename}.acl.json`);
}
function register(result) {
  if (!governance.current() || !result?.downloadUrl) return;
  const actor = governance.principal(), filename = result.fileName || decodeURIComponent(result.downloadUrl.split('/').at(-1));
  const file = metadataPath(filename);
  const record = { schemaVersion: '1', owner: actor.subject, expiresAt: Date.now() + 3600000,
    resources: [...governance.current().resources.values()].map(({ resource, type }) => ({ type, id: resource.id, revision: resource.governedPolicy?.revision || 0 })) };
  const temporary = `${file}.${require('node:crypto').randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file);
}
function authorize(filename) {
  const file = metadataPath(filename), actor = governance.principal();
  const reject = () => { throw Object.assign(new Error('Không tìm thấy file hoặc quyền tải đã hết hạn.'), { statusCode: 404, code: 'ARTIFACT_ACCESS_DENIED' }); };
  if (!actor || !fs.existsSync(file)) return reject();
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.owner !== actor.subject || record.expiresAt <= Date.now()) return reject();
  for (const ref of record.resources || []) {
    const resource = ref.type === 'sql' ? require('../services/sql_connector').dbSources.find(item => item.id === ref.id) : require('../knowledge_core/services/library_service').findDocument(ref.id);
    if (!resource || !governance.canRead(resource) || (resource.governedPolicy?.revision || 0) !== ref.revision) return reject();
  }
  return record;
}
module.exports = { register, authorize };
