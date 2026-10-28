'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('../src/backend/governance/context');
const routes = require('../src/backend/governance/routes');
const sql = require('../src/backend/services/sql_connector');
async function request(method, account, body) {
  let status, value;
  const response = { writeHead(code) { status = code; }, end(json) { value = JSON.parse(json); } };
  await routes.handle({ method }, response, '/api/governance/resources', account, async () => body);
  return { status, value };
}
test('resource policy endpoint requires admin, validates schema, and rejects stale revisions', async () => context.run(async () => {
  const source = { id: 'route-fixture', name: 'Fixture', password: 'secret-not-in-view' }; sql.dbSources.push(source);
  const account = { id: 'a', role: 'admin' }; context.setPrincipal({ subject: 'account:a', role: 'admin' });
  const policy = { visibility: 'restricted', sensitivity: 'internal', subjects: ['account:a'], roles: [], embedIds: [], modelDestinations: [] };
  try {
    assert.equal((await request('GET', { role: 'user' })).status, 403);
    const list = await request('GET', account); assert.equal(list.status, 200); assert.ok(!JSON.stringify(list.value).includes('secret-not-in-view'));
    const body = { id: source.id, type: 'sql', expectedRevision: 0, policy };
    assert.equal((await request('PUT', account, { ...body, policy: { ...policy, arbitrary: true } })).status, 400);
    const saved = await request('PUT', account, body); assert.equal(saved.status, 200); assert.equal(saved.value.resource.policy.revision, 1);
    assert.equal((await request('PUT', account, body)).status, 409);
  } finally { sql.dbSources = sql.dbSources.filter(item => item.id !== source.id); sql.persist(); }
}));
test('tool outputs must fit their schema and size limit before they reach the model', async () => {
  const BaseTool = require('../src/backend/agent/tools/base_tool');
  class Output extends BaseTool {
    constructor(value, options) { super({ name: 'output-fixture', description: 'test', ...options }); this.value = value; }
    async run() { return this.value; }
  }
  const schema = { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer' } } };
  assert.equal((await new Output({ count: 'wrong' }, { outputSchema: schema }).execute({})).code, 'TOOL_OUTPUT_INVALID');
  assert.equal((await new Output({ text: 'x'.repeat(100) }, { maxOutputBytes: 20 }).execute({})).code, 'TOOL_OUTPUT_TOO_LARGE');
  assert.equal((await new Output({ count: 1 }, { outputSchema: schema }).execute({})).success, true);
});
test('function groups, version 2 policies and the effective report work over the governance routes', async () => context.run(async () => {
  const groups = require('../src/backend/services/account_function_groups'), roles = require('../src/backend/services/account_roles');
  const storage = require('../src/backend/utils/storage_helper');
  const previous = { groups: groups.groups, roles: roles.roles, save: storage.saveJson };
  storage.saveJson = () => true;
  const source = { id: 'route-v2', name: 'Fixture v2' }; sql.dbSources.push(source);
  const account = { id: 'a', role: 'admin' }; context.setPrincipal({ subject: 'account:a', role: 'admin' });
  const call = async (method, pathname, body, url = pathname) => {
    let status, value; const response = { writeHead(code) { status = code; }, end(json) { value = JSON.parse(json); } };
    await routes.handle({ method, url }, response, pathname, account, async () => body); return { status, value };
  };
  try {
    groups.groups = []; roles.roles = [];
    const created = await call('POST', '/api/governance/function-groups', { id: 'tai_chinh', name: 'Tài chính', permissions: ['chat.use', 'sql:read'] });
    assert.equal(created.status, 201);
    roles.save({ id: 'ke_toan', name: 'Kế toán', functionGroups: ['tai_chinh'] });
    const policy = { schemaVersion: 2, access: { mode: 'grants', users: [], denyUsers: [] }, aiSharing: { level: 'local', excludeDestinations: [] } };
    const saved = await call('PUT', '/api/governance/resources', { type: 'sql', id: source.id, expectedRevision: 0, policy, functionGroups: ['tai_chinh'] });
    assert.equal(saved.status, 200); assert.deepEqual(saved.value.resource.functionGroups, ['tai_chinh']);
    assert.equal(saved.value.resource.policy.aiSharing.level, 'local');
    const report = await call('GET', '/api/governance/effective', null, '/api/governance/effective?role=ke_toan');
    const item = report.value.resources.find(entry => entry.id === source.id);
    assert.equal(item.allowed, true); assert.equal(item.reason, 'GRANT_FUNCTION_GROUP'); assert.deepEqual(item.via, ['Tài chính']);
    const bulk = await call('POST', '/api/governance/resources/bulk', { items: [{ type: 'sql', id: source.id, expectedRevision: 0 }], patch: { aiSharing: { level: 'off' } } });
    assert.equal(bulk.status, 409);
    assert.equal((await call('POST', '/api/governance/resources/bulk', { items: [{ type: 'sql', id: source.id, expectedRevision: 1 }], patch: { aiSharing: { level: 'off' } } })).status, 200);
    assert.equal(rulesLevel(source), 'off');
  } finally { groups.groups = previous.groups; roles.roles = previous.roles; storage.saveJson = previous.save; sql.dbSources = sql.dbSources.filter(item => item.id !== source.id); }
}));
function rulesLevel(source) { return require('../src/backend/governance/policy').normalize(source.governedPolicy).aiSharing.level; }
