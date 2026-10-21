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
  const BaseTool = require('../src/backend/agent_core/tools/base_tool');
  class Output extends BaseTool {
    constructor(value, options) { super({ name: 'output-fixture', description: 'test', ...options }); this.value = value; }
    async run() { return this.value; }
  }
  const schema = { type: 'object', additionalProperties: false, required: ['count'], properties: { count: { type: 'integer' } } };
  assert.equal((await new Output({ count: 'wrong' }, { outputSchema: schema }).execute({})).code, 'TOOL_OUTPUT_INVALID');
  assert.equal((await new Output({ text: 'x'.repeat(100) }, { maxOutputBytes: 20 }).execute({})).code, 'TOOL_OUTPUT_TOO_LARGE');
  assert.equal((await new Output({ count: 1 }, { outputSchema: schema }).execute({})).success, true);
});
