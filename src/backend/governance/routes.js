'use strict';
const Ajv = require('ajv');
const validate = new Ajv({ strict: false }).compile({ type: 'object', additionalProperties: false,
  properties: { visibility: { enum: ['shared', 'restricted'] }, sensitivity: { enum: ['public', 'internal', 'restricted'] },
    subjects: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
    roles: { type: 'array', items: { type: 'string', minLength:1, maxLength:40 } }, embedIds: { type: 'array', items: { type: 'string' }, maxItems: 100 },
    modelDestinations: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
    allowedTables: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 },
    blockedColumns: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 100 } },
  required: ['visibility', 'sensitivity', 'subjects', 'roles', 'embedIds', 'modelDestinations'] });
async function handle(req, res, pathname, account, readBody) {
  if (!['/api/governance/resources', '/api/governance/metrics', '/api/governance/operations'].includes(pathname)) return false;
  const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (account?.role !== 'admin') { send(403, { message: 'Cần quyền quản trị.' }); return true; }
  if (pathname === '/api/governance/operations') {
    if (req.method !== 'GET') { send(405, { message: 'Method not allowed' }); return true; }
    try {
      const operations = require('./operations');
      send(200, operations.summarize(await operations.loadAudits(), operations.readPolicy()));
    } catch (error) { send(400, { code: error.code || 'OPERATIONS_REPORT_FAILED', message: 'Không thể tạo báo cáo vận hành. Kiểm tra cấu hình chính sách.' }); }
    return true;
  }
  const library = require('../knowledge_core/services/library_service'), sql = require('../services/sql_connector');
  if (pathname === '/api/governance/metrics') {
    const metrics = require('./metrics');
    if (req.method === 'GET') { send(200, { metrics: sql.dbSources.flatMap(source => (source.governedMetrics || []).map(metric => ({ ...metric, sourceId: source.id }))) }); return true; }
    if (req.method === 'PUT') {
      try { const body = await readBody(req); send(200, { metric: metrics.save(body.sourceId, body.definition, body.expectedRevision) }); }
      catch (error) { send(error.statusCode || 400, { message: error.message, code: error.code }); }
      return true;
    }
    send(405, { message: 'Method not allowed' }); return true;
  }
  const resources = [...library.documents.map(resource => ({ type: 'document', resource })), ...sql.dbSources.map(resource => ({ type: 'sql', resource }))];
  const view = ({ type, resource }) => ({ type, id: resource.id, name: resource.title || resource.name || resource.dbName || resource.database || resource.id,
    policy: resource.governedPolicy || { revision: 0, visibility: 'shared', sensitivity: 'internal', subjects: [], roles: [], embedIds: [], modelDestinations: [] } });
  if (req.method === 'GET') { send(200, { readOnly: require('../automation/read_only_policy').enabled(), externalReadOnly: require('../automation/read_only_policy').externalReadOnly(), resources: resources.map(view),
    providers: require('../services/ai_provider_manager').getProvidersForExecution().map(provider => ({ id: provider.id, name: provider.name, model: provider.model })) }); return true; }
  if (req.method === 'PUT') {
    try {
      const body = await readBody(req), item = resources.find(item => item.type === body.type && item.resource.id === body.id);
      if (!item) throw Object.assign(new Error('Không tìm thấy tài nguyên.'), { statusCode: 404 });
      if (!validate(body.policy)) throw Object.assign(new Error('Chính sách không đúng schema.'), { statusCode: 400 });
      if (body.policy.roles.some(id=>!require('../services/account_roles').get(id))) throw Object.assign(new Error('Vai trò không tồn tại.'),{statusCode:400});
      const revision = item.resource.governedPolicy?.revision || 0;
      if (body.expectedRevision !== revision) throw Object.assign(new Error('Chính sách đã thay đổi. Hãy tải lại.'), { statusCode: 409 });
      item.resource.governedPolicy = { ...structuredClone(body.policy), revision: revision + 1, updatedBy: account.id, updatedAt: new Date().toISOString() };
      (item.type === 'document' ? library : sql).persist();
      send(200, { resource: view(item) });
    } catch (error) { send(error.statusCode || 400, { message: error.message }); }
    return true;
  }
  send(405, { message: 'Method not allowed' }); return true;
}
module.exports = { handle };
