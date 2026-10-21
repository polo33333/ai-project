'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { ApplicationClient } = require('../scripts/workflow_mcp');
const { authoringContext } = require('../src/backend/automation/authoring_context');

test('authoring catalog excludes secrets, rows, inactive sources/tables and hidden columns', () => {
  const catalog = authoringContext({ dbSources: [{ id: 'live', mode: 'live', password: 'secret', connectionString: 'secret' }, { id: 'offline' }] }, {
    getGroupedTables: () => [
      { tableId: 'a', dbSourceId: 'live', tableName: 'A', rows: ['secret'], columns: [{ columnName: 'code', dataType: 'varchar', sampleValues: ['secret'] }, { columnName: 'hidden', isVisible: false }] },
      { tableId: 'b', dbSourceId: 'live', tableName: 'B', columns: [] },
      { tableId: 'disabled', dbSourceId: 'live', isActive: false }, { tableId: 'offline', dbSourceId: 'offline' }
    ],
    getTableRelationships: () => [{ id: 'ok', sourceTableId: 'a', targetTableId: 'b', evidence: { secret: true } }, { id: 'no', sourceTableId: 'a', targetTableId: 'disabled' }]
  });
  assert.equal(catalog.tables.length, 2);
  assert.deepEqual(catalog.tables[0].columns, [{ columnName: 'code', dataType: 'varchar' }]);
  assert.equal(catalog.relationships.length, 1);
  assert.ok(!JSON.stringify(catalog).includes('secret'));
});

test('MCP client refuses credential-bearing URLs and remote cleartext HTTP', () => {
  for (const url of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/path', 'file:///tmp/app'])
    assert.throws(() => new ApplicationClient({ KH_MCP_BASE_URL: url }));
  assert.doesNotThrow(() => new ApplicationClient({ KH_MCP_BASE_URL: 'https://example.com' }));
});

test('expired sessions do not silently replay writes; next call signs in again', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/auth/login')) return new Response(JSON.stringify({ account: { role: 'admin' } }), { headers: { 'Set-Cookie': 'kh_session=new-session; HttpOnly' } });
    if (options.headers.Cookie === 'kh_session=expired') return new Response(JSON.stringify({ message: 'UNAUTHENTICATED' }), { status: 401 });
    return new Response('{}');
  };
  const client = new ApplicationClient({ KH_MCP_USERNAME: 'admin', KH_MCP_PASSWORD: 'test-password' }, fakeFetch);
  client.cookie = 'kh_session=expired';
  await assert.rejects(client.request('/api/workflow-plugins', 'POST', {}), /Session expired/);
  assert.equal(requests.length, 1);
  await client.request('/api/workflow-plugins');
  assert.equal(requests.length, 3);
  assert.ok(requests[1].url.endsWith('/api/auth/login'));
  assert.equal(requests[2].options.headers.Cookie, 'kh_session=new-session');
});

test('stdio MCP -> authenticated application: draft, conflict, validate and fixture report', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'workflow-mcp-isolated-test';
  const { handleRequest } = require('../src/backend/routes/router');
  const app = http.createServer((req, res) => handleRequest(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }));
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.closeAllConnections(); return new Promise(resolve => app.close(resolve)); });
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + '/api/workflow-plugins/authoring-context')).status, 401);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../scripts/workflow_mcp.js')],
    env: { ...process.env, KH_MCP_BASE_URL: base, KH_MCP_USERNAME: 'admin', KH_MCP_PASSWORD: process.env.BOOTSTRAP_ADMIN_PASSWORD }, stderr: 'pipe' });
  const client = new Client({ name: 'workflow-mcp-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { result, data: JSON.parse(result.content[0].text) };
  };
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 7);
  assert.ok(!names.some(name => name.includes('publish') || name.includes('execute')));
  const guide = (await call('workflow_guide')).data;
  assert.equal(guide.contractVersion, 1);
  assert.ok(guide.contractSource.includes('validatePackage'));
  assert.equal((await call('workflow_catalog')).result.isError, undefined);
  assert.equal((await call('workflow_list')).result.isError, undefined);
  const bundle = guide.example;
  bundle.manifest.id = 'mcp_authoring_test'; bundle.manifest.name = 'MCP test';
  const saved = await call('workflow_save_draft', { bundle, revision: null });
  assert.equal(saved.result.isError, undefined, JSON.stringify(saved.data));
  assert.equal(saved.data.package.revision, 1);
  assert.equal(saved.data.package.published, undefined);
  const conflict = await call('workflow_save_draft', { bundle, revision: null });
  assert.equal(conflict.result.isError, true);
  assert.equal(conflict.data.status, 409);
  const packageId = bundle.manifest.id;
  const fetched = await call('workflow_get', { packageId });
  assert.equal(fetched.data.package.revision, 1);
  bundle.templates[0].description = 'Updated by MCP';
  assert.equal((await call('workflow_save_draft', { bundle, revision: 1 })).data.package.revision, 2);
  assert.equal((await call('workflow_validate', { packageId })).data.valid, true);
  const report = await call('workflow_test', { packageId });
  assert.equal(report.data.passed, true);
  assert.equal(report.data.liveSqlExecuted, false);
  assert.equal((await call('workflow_get', { packageId })).data.package.revision, 3);
  assert.equal((await call('workflow_save_draft', { bundle, revision: '3' })).result.isError, true);
  assert.equal((await call('workflow_get', { packageId: 'missing' })).data.status, 404);
  assert.equal((await call('workflow_publish', { packageId })).result.isError, true);
  const invalid = structuredClone(bundle); invalid.templates[0].workflow.steps[0].type = 'shell';
  assert.equal((await call('workflow_save_draft', { bundle: invalid, revision: 3 })).result.isError, true);
  // Authorization is checked by the running application, not inferred by MCP.
  const auth = require('../src/backend/services/auth_service');
  t.mock.method(auth, 'getAccountBySession', () => ({ id: 'reader', role: 'user' }));
  assert.equal((await fetch(base + '/api/workflow-plugins/authoring-context', { headers: { Cookie: 'kh_session=reader' } })).status, 403);
  assert.equal((await call('workflow_catalog')).data.status, 403);
});
