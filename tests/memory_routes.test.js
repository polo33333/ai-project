'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const governance = require('../src/backend/governance/context');
const routes = require('../src/backend/memory_core/routes');
async function request(method, account, body, path = '/api/memory') {
  let status, value;
  const response = { writeHead(code) { status = code; }, end(json) { value = JSON.parse(json); } };
  await routes.handle({ method, url: path }, response, path, account, async () => body);
  return { status, value };
}
test('memory API requires authentication, ignores spoofed owners and prevents approval by a regular user', () => governance.run(async () => {
  assert.equal((await request('GET', null)).status, 401);
  governance.setPrincipal({ subject: 'account:memory-a', role: 'user', channel: 'chat' });
  const account = { id: 'memory-a', role: 'user' };
  const response = await request('POST', account, { title: 'Test', content: 'Use short answers', owner: 'account:victim', scope: 'organization', approved: true });
  assert.equal(response.status, 200); assert.equal(response.value.item.owner, 'account:memory-a'); assert.equal(response.value.item.status, 'pending');
  assert.equal((await request('POST', account, {}, '/api/memory/events')).status, 405);
  governance.setPrincipal({ subject: 'account:memory-b', role: 'user', channel: 'chat' });
  assert.equal((await request('DELETE', { id: 'memory-b' }, { id: response.value.item.id, revision: 1 })).status, 404);
}));
