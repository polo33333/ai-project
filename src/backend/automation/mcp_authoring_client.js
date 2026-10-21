'use strict';
const automation = require('./index');
const { requireAdmin } = require('./registry');
const { error } = require('./contract');

// Same authoring operations as the HTTP UI, without loopback requests or admin passwords.
class AuthoringClient {
  constructor(account) {
    this.context = { accountId: account.id, tenantId: account.tenantId, permissions: account.role === 'admin' ? ['admin'] : account.permissions };
  }
  async request(route, method = 'GET', body = {}) {
    requireAdmin(this.context);
    if (route === '/api/workflow-plugins/authoring-context') return require('./authoring_context').authoringContext(require('../services/sql_connector'), require('../services/dictionary_service'));
    if (route === '/api/workflow-plugins') {
      if (method === 'GET') return { packages: await automation.registry.list(this.context, { admin: true }) };
      if (method === 'POST') return { package: await automation.registry.import(body.bundle, this.context, body.revision) };
    }
    const parts = route.split('/');
    if (parts.length >= 4 && parts[2] === 'workflow-plugins') {
      const id = decodeURIComponent(parts[3]);
      if (method === 'GET' && parts.length === 4) {
        const record = await automation.repository.get('catalog', id);
        if (!record?.draft) throw error('Không tìm thấy gói.', 404);
        return { package: record };
      }
      if (method === 'POST' && parts.length === 5 && ['validate', 'test'].includes(parts[4])) return automation.registry[parts[4]](id, this.context);
    }
    throw error('MCP operation not supported.', 404);
  }
}
module.exports = { AuthoringClient };
