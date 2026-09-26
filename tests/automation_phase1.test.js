'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutomationRepository } = require('../src/backend/automation/repository');
const { PluginRegistry } = require('../src/backend/automation/registry');
const { AutomationRuntime } = require('../src/backend/automation/runtime');
const { validatePackage, validateValue } = require('../src/backend/automation/contract');
const pilot = require('../src/backend/automation/pilot.json');
const admin = { accountId: 'admin-test', permissions: ['admin'] };
const user = { accountId: 'user-test', permissions: ['sql:read'] };
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = new AutomationRepository({ directory });
  const registry = new PluginRegistry(repository);
  const runtime = new AutomationRuntime(repository, registry, { enabled: () => true, authorizeContext: async accountId => ({ ...user, accountId }), ...options });
  return { repository, registry, runtime, directory };
}
async function publish(registry, bundle = pilot) {
  let record = await registry.import(structuredClone(bundle), admin);
  const report = await registry.test(record.id, admin); assert.equal(report.passed, true, JSON.stringify(report));
  record = await registry.repository.get('catalog', record.id);
  return registry.publish(record.id, admin, record.revision);
}
test('five pilot definitions pass fixture validation and execute through the persistent worker', async t => {
  const { registry, runtime } = setup(t); await publish(registry);
  for (const template of pilot.templates) {
    const run = await runtime.create(`phase1_examples/${template.id}`, template.fixtures[0].input, user, { conversationId: template.id });
    await runtime.process(run.id);
    const final = runtime.view(await runtime.owned(run.id, user));
    assert.equal(final.status, 'SUCCEEDED', `${template.id}: ${final.error}`);
    assert.deepEqual(final.result, template.fixtures[0].expected);
    if (template.id === 'export') {
      assert.equal(final.artifacts.length, 1);
      assert.ok(fs.existsSync((await runtime.artifact(run.id, final.artifacts[0].id, user)).path));
      await assert.rejects(runtime.artifact(run.id, final.artifacts[0].id, admin), { statusCode: 404 });
    }
  }
});
test('missing inputs block execution, provenance survives restart and concurrent updates use CAS', async t => {
  const { registry, runtime, directory } = setup(t); await publish(registry);
  let run = await runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'slots' });
  assert.equal(run.status, 'WAITING_INPUT'); await runtime.process(run.id);
  assert.deepEqual((await runtime.owned(run.id, user)).attempts, {});
  const concurrent = await Promise.allSettled([
    runtime.inputs(run.id, { code: 'A001' }, user, run.revision),
    runtime.inputs(run.id, { code: 'A002' }, user, run.revision)
  ]);
  assert.equal(concurrent.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(item => item.status === 'rejected').reason.statusCode, 409);
  const repository = new AutomationRepository({ directory });
  const restarted = new AutomationRuntime(repository, new PluginRegistry(repository), { enabled: () => true, authorizeContext: async () => user });
  await restarted.process(run.id); run = restarted.view(await restarted.owned(run.id, user));
  assert.equal(run.status, 'SUCCEEDED'); assert.equal(run.provenance.code.source, 'user');
});
test('two external domain packages route, collect, execute and render without engine changes', async t => {
  const { registry, runtime } = setup(t);
  for (const [id, name, inputName] of [['lab_samples', 'Kiểm tra mẫu xét nghiệm', 'sample'], ['shipping_routes', 'Tra cứu tuyến vận chuyển', 'route']]) {
    const bundle = structuredClone(pilot); bundle.manifest.id = id; bundle.templates = [bundle.templates[0]];
    const template = bundle.templates[0]; template.id = `definition_${id}`; template.name = name; template.examples = [name];
    template.inputs = { [inputName]: { schema: { type: 'string', minLength: 1 }, required: true, ask: `Bạn chọn ${inputName} nào?` } };
    template.workflow.steps[0].config.mapping = { code: `{{input.${inputName}}}`, source: id };
    template.fixtures = [{ input: { [inputName]: 'fixture-42' }, expected: { code: 'fixture-42', source: id } }];
    await publish(registry, bundle);
    const match = await registry.match(name, user); assert.equal(match.status, 'matched');
    const started = await runtime.create(match.definition.id, {}, user, { conversationId: id }); assert.equal(started.status, 'WAITING_INPUT');
    await runtime.inputs(started.id, { [inputName]: 'fixture-42' }, user, started.revision); await runtime.process(started.id);
    assert.deepEqual(runtime.view(await runtime.owned(started.id, user)).result, template.fixtures[0].expected);
  }
});
test('draft import failures do not break another package, publish requires current tests', async t => {
  const { registry } = setup(t); await publish(registry);
  const invalid = structuredClone(pilot); invalid.manifest.id = 'broken'; invalid.templates[0].workflow.steps[0].type = 'javascript';
  await assert.rejects(registry.import(invalid, admin), /Step\/capability/);
  assert.equal((await registry.match('Tra cứu đối tượng', user)).status, 'matched');
  const modified = structuredClone(pilot); modified.manifest.version = 2; modified.templates[0].name = 'Thay đổi';
  const old = await registry.repository.get('catalog', 'phase1_examples');
  const draft = await registry.import(modified, admin, old.revision);
  await assert.rejects(registry.publish(draft.id, admin, draft.revision), /fixture/);
  assert.equal((await registry.getTemplate('phase1_examples/lookup', user)).name, 'Tra cứu đối tượng');
});
test('owner checks, field injection, idempotency and one pending run per conversation', async t => {
  const { registry, runtime } = setup(t); await publish(registry);
  const run = await runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'owner', requestId: 'unique' });
  assert.equal((await runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'owner', requestId: 'unique' })).id, run.id);
  await assert.rejects(runtime.create('phase1_examples/lookup', { code: 'changed' }, user, { conversationId: 'owner', requestId: 'unique' }), /nội dung khác/);
  await assert.rejects(runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'owner' }), { statusCode: 409 });
  await assert.rejects(runtime.owned(run.id, admin), { statusCode: 404 });
  await assert.rejects(runtime.inputs(run.id, { ownerId: 'admin-test' }, user, run.revision), /không được khai báo/);
  await assert.rejects(registry.import(pilot, user), { statusCode: 403 });
});
test('version pinning, disabled discovery, overlay restrictions and rollback', async t => {
  const { registry, runtime } = setup(t); let record = await publish(registry);
  const run = await runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'pinned' });
  const overlay = structuredClone(record.published); overlay.templates[0].inputs.code.ask = 'Mã tùy chỉnh của bạn?';
  record = await registry.overlay(record.id, 'account:user-test', overlay, admin, record.revision);
  assert.equal((await registry.getTemplate(run.templateId, user)).inputs.code.ask, 'Mã tùy chỉnh của bạn?');
  assert.notEqual((await runtime.owned(run.id, user)).definition.inputs.code.ask, 'Mã tùy chỉnh của bạn?');
  const malicious = structuredClone(overlay); malicious.templates[0].audience = { accountIds: ['someone'] };
  await assert.rejects(registry.overlay(record.id, 'account:user-test', malicious, admin, record.revision), /audience/);
  record = await registry.enable(record.id, false, admin, record.revision);
  assert.equal((await registry.match('Tra cứu đối tượng', user)).status, 'no_match');
  await runtime.inputs(run.id, { code: 'still-pinned' }, user, run.revision); await runtime.process(run.id);
  assert.equal((await runtime.owned(run.id, user)).status, 'SUCCEEDED');
  await registry.rollback(record.id, 1, admin, record.revision);
});
test('cancel prevents later steps; expired worker resumes reads but exports require review', async t => {
  const { registry, runtime, repository } = setup(t); await publish(registry);
  const waiting = await runtime.create('phase1_examples/lookup', {}, user, { conversationId: 'cancel' });
  await runtime.cancel(waiting.id, user, waiting.revision); await runtime.process(waiting.id);
  assert.equal((await runtime.owned(waiting.id, user)).status, 'CANCELLED');
  const read = await runtime.create('phase1_examples/lookup', { code: 'resume' }, user, { conversationId: 'recovery' });
  let raw = await runtime.owned(read.id, user); raw.status = 'RUNNING'; raw.lease = { token: 'dead', expiresAt: 0 }; await repository.put('runs', raw, raw.revision);
  await runtime.process(read.id); assert.equal((await runtime.owned(read.id, user)).status, 'SUCCEEDED');
  const exported = await runtime.create('phase1_examples/export', { rows: [{ id: 1 }] }, user, { conversationId: 'export-recovery' });
  raw = await runtime.owned(exported.id, user); raw.status = 'RUNNING'; raw.lease = { token: 'dead', expiresAt: 0 }; await repository.put('runs', raw, raw.revision);
  await runtime.process(exported.id); assert.equal((await runtime.owned(exported.id, user)).status, 'NEEDS_REVIEW');
});
test('strict schema rejects impossible dates and prototype pollution before storage', () => {
  assert.ok(validateValue('2026-02-31', { type: 'string', format: 'date' }).length);
  const corrupted = JSON.parse(JSON.stringify(pilot).replace('"inputs":', '"__proto__":{"polluted":true},"inputs":'));
  assert.throws(() => validatePackage(corrupted), /không an toàn/); assert.equal({}.polluted, undefined);
});
test('checkpoint recovery skips completed steps and required phase 2 review blocks execution', async t => {
  const { registry, runtime, repository } = setup(t); await publish(registry);
  const started = await runtime.create('phase1_examples/range', { from: '2026-09-01', to: '2026-09-26' }, user, { conversationId: 'boundary' });
  let raw = await runtime.owned(started.id, user);
  raw.status = 'RUNNING'; raw.nextIndex = 1; raw.outputs.dates = { valid: true }; raw.attempts.dates = { count: 1, status: 'SUCCEEDED' }; raw.lease = { token: 'dead', expiresAt: 0 };
  await repository.put('runs', raw, raw.revision); await runtime.process(raw.id);
  raw = await runtime.owned(raw.id, user); assert.equal(raw.status, 'SUCCEEDED'); assert.equal(raw.attempts.dates.count, 1); assert.equal(raw.attempts.prepare.count, 1);
  const bundle = structuredClone(pilot); bundle.manifest.id = 'required_review'; bundle.templates = [bundle.templates[0]]; bundle.templates[0].review = { mode: 'required' };
  await publish(registry, bundle);
  const blocked = await runtime.create('required_review/lookup', { code: 'A001' }, user, { conversationId: 'required' });
  assert.equal(blocked.status, 'NEEDS_REVIEW'); await runtime.process(blocked.id); assert.deepEqual((await runtime.owned(blocked.id, user)).attempts, {});
});
test('current audience revocation blocks a previously pinned run', async t => {
  const { registry, runtime } = setup(t); const original = await publish(registry);
  const run = await runtime.create('phase1_examples/lookup', { code: 'A001' }, user, { conversationId: 'revoke' });
  const bundle = structuredClone(pilot); bundle.manifest.version = 2; bundle.manifest.audience = { accountIds: ['different-account'] };
  let updated = await registry.import(bundle, admin, original.revision); await registry.test(updated.id, admin); updated = await registry.repository.get('catalog', updated.id); await registry.publish(updated.id, admin, updated.revision);
  await runtime.process(run.id); const revoked = await runtime.owned(run.id, user); assert.equal(revoked.status, 'FAILED'); assert.match(revoked.error, /thu hồi/);
});
test('SQL binding uses typed parameters and rejects tables outside the allowlist', async t => {
  const { validateBinding, executeBinding } = require('../src/backend/automation/sql');
  const connector = require('../src/backend/services/sql_connector');
  const binding = { sql: 'SELECT TOP 10 [Name] FROM [dbo].[People] WHERE [Code]=@code', dbSourceId: 'fixture-db', tables: ['dbo.People'], parameters: { code: { slot: 'code', type: 'string' } } };
  assert.match(validateBinding(binding), /@code/);
  assert.throws(() => validateBinding({ ...binding, tables: ['dbo.Other'] }), /ngoài binding/);
  assert.throws(() => validateBinding({ ...binding, sql: 'DELETE FROM dbo.People' }), /Read-Only/);
  connector.dbSources = [{ id: 'fixture-db' }]; connector.schemas = [{ dbSourceId: 'fixture-db', schemaName: 'dbo', tableName: 'People' }];
  let received;
  t.mock.method(connector, 'executeSqlQuery', async (...args) => { received = args; return [{ Name: 'Dữ liệu' }]; });
  const injected = "O'Brien'; DROP TABLE People;--";
  const result = await executeBinding(binding, { code: injected }, user);
  assert.equal(result.rowCount, 1); assert.ok(!received[0].includes(injected));
  assert.deepEqual(received[3], [{ name: 'code', type: 'string', value: injected }]);
  await assert.rejects(executeBinding(binding, { code: 'a' }, { permissions: [] }), { statusCode: 403 });
});
