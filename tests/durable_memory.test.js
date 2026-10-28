'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const governance = require('../src/backend/governance/context');
const { DurableMemory } = require('../src/backend/memory_core/durable_memory');
const { MemoryService } = require('../src/backend/memory_core/memory_service');
const sql = require('../src/backend/services/sql_connector');
function memory() { return new DurableMemory({ records: [], events: [], saveRecords() {}, saveEvents() {} }); }
function actor(id, role = 'user', tenantId = 'org') { governance.setPrincipal({ subject: `account:${id}`, role, tenantId, channel: 'chat' }); }
const preference = { title: 'Language', content: 'Use Vietnamese', scope: 'personal' };

test('personal memory is isolated from other users, admins, organizations and embed', () => governance.run(() => {
  const m = memory(); actor('a'); const saved = m.save(preference);
  actor('b'); assert.deepEqual(m.list().items, []);
  assert.throws(() => m.save({ ...saved, content: 'override' }), /quyền/);
  actor('admin', 'admin'); assert.deepEqual(m.list().items, []);
  assert.throws(() => m.remove(saved.id, saved.revision), /tìm thấy/);
  actor('a', 'user', 'other-org'); assert.deepEqual(m.list().items, []);
  governance.setPrincipal({ subject: 'embed:widget:visitor', channel: 'embed', embedId: 'widget' });
  assert.throws(() => m.list(), /đăng nhập/);
  assert.deepEqual(m.context(), []);
}));

test('organizational proposals require admin approval and edits reset approval', () => governance.run(() => {
  const m = memory(); actor('a'); const proposal = m.save({ ...preference, scope: 'organization', approved: true });
  assert.equal(proposal.status, 'pending'); assert.deepEqual(m.context(), []);
  actor('b'); assert.deepEqual(m.list().items, []);
  actor('admin', 'admin'); const approved = m.save({ ...proposal, approved: true });
  assert.equal(approved.status, 'approved');
  actor('b'); assert.equal(m.list({ approvedOnly: true }).items.length, 1);
  assert.ok(m.context()[0].content.includes('Use Vietnamese'));
  actor('a'); m.save({ ...approved, content: 'Updated guidance' });
  actor('b'); assert.deepEqual(m.context(), []);
}));

test('memory changes enforce revisions, expiration and explicit current-user provenance', () => governance.run(() => {
  const m = memory(); actor('a');
  assert.throws(() => m.save(preference, { source: 'chat', quote: 'remember', userMessage: 'hello' }), /trích dẫn/);
  assert.throws(() => m.save({ ...preference, scope: 'organization' }, { source: 'chat', quote: 'remember', userMessage: 'remember' }), /trích dẫn/);
  const saved = m.save(preference, { source: 'chat', quote: 'remember this', userMessage: 'please remember this preference' });
  assert.equal(saved.provenance.source, 'chat');
  assert.throws(() => m.save({ ...saved, revision: 0 }), error => error.statusCode === 409);
  assert.throws(() => m.remove(saved.id, 0), error => error.statusCode === 409);
  m.records[0].expiresAt = '2000-01-01T00:00:00Z'; assert.deepEqual(m.list().items, []);
  m.remove(saved.id, saved.revision); assert.equal(m.records.length, 0);
}));

test('task events retain references instead of rows, obey source ACL/revision and register egress', () => governance.run(() => {
  const m = memory(); actor('a');
  const source = { id: 'memory-source', governedPolicy: { visibility: 'restricted', subjects: ['account:a'], sensitivity: 'restricted', revision: 2 } };
  sql.dbSources.push(source);
  try {
    m.recordEvent({ accountId: 'a', sessionId: 's', question: 'List customers', currentPlan: { table: 'M_Customer', dbSourceId: source.id },
      resources: [{ type: 'sql', id: source.id, revision: 2 }] });
    const event = m.list({ events: true, query: 'customers', register: true }).items[0];
    assert.equal(event.table, 'M_Customer'); assert.equal(event.rows, undefined);
    assert.ok(governance.current().resources.has(`sql:${source.id}`));
    assert.throws(() => governance.assertEgress('cloud-provider', false));
    source.governedPolicy.revision = 3; assert.equal(m.list({ events: true }).items.length, 0);
    source.governedPolicy.revision = 2; source.governedPolicy.subjects = [];
    assert.equal(m.list({ events: true }).items.length, 0);
  } finally { sql.dbSources = sql.dbSources.filter(item => item.id !== source.id); }
}));

test('workflow event updates are idempotent and public embed never records long-term events', () => governance.run(() => {
  const m = memory(); actor('a');
  const event = { accountId: 'a', sessionId: 's', question: 'Run report', currentPlan: {}, workflow: { runId: 'run', name: 'Report' } };
  m.recordEvent(event); m.recordEvent(event); assert.equal(m.events.length, 1); assert.equal(m.events[0].revision, 2);
  actor('b'); assert.equal(m.list({ events: true }).total, 0);
  governance.setPrincipal({ subject: 'embed:w', channel: 'embed' });
  m.recordEvent({ ...event, accountId: 'embed:w' }); assert.equal(m.events.length, 1);
}));

test('durable context is bounded, contains no pending guidance and is disabled by flag', t => governance.run(() => {
  const m = memory(); actor('a');
  for (let i = 0; i < 5; i++) m.save({ ...preference, title: `Preference ${i}`, content: 'a'.repeat(1000) });
  const context = m.context()[0].content;
  assert.ok(context.length < 3000);
  const previous = process.env.MEMORY_DURABLE_ENABLED; process.env.MEMORY_DURABLE_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.MEMORY_DURABLE_ENABLED; else process.env.MEMORY_DURABLE_ENABLED = previous; });
  assert.deepEqual(m.context(), []); assert.equal(m.list().disabled, true);
  assert.throws(() => m.save(preference), /đang tắt/);
}));

test('agent conversation state preserves an entity even when old topic rules select no history', () => {
  const now = new Date().toISOString();
  const m = new MemoryService({ store: { sessions: {} }, save() {} });
  const session = m.getSession('s', true, 'a');
  session.lastPlan = { table: 'M_Employee', dbSourceId: 'sql-a' };
  session.references.lastEntity = { table: 'M_Employee', filters: { EmployeeCode: 'NV004' }, updatedAt: now };
  session.messages = [{ role: 'user', content: 'NV004 gender?' }, { role: 'assistant', content: 'NV004 is male.' }];
  const context = m.getAgentState({ mode: 'none', sessionId: 's', accountId: 'a' }, { dbSourceId: 'sql-a' });
  assert.ok(context[0].content.includes('NV004')); assert.equal(context.length, 3);
  assert.deepEqual(m.getAgentState({ mode: 'none', sessionId: 's', accountId: 'b' }, {}), []);
  assert.deepEqual(m.getAgentState({ mode: 'none', sessionId: 's', accountId: 'a' }, { dbSourceId: 'sql-b' }), []);
});
