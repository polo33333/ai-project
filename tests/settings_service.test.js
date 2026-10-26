const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsService } = require('../src/backend/services/settings_service');
function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-settings-'));
  const file = path.join(dir, '.env'); fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { service: createSettingsService(file), file };
}

test('harness pipeline is selectable, persists v1/v2 and rejects unsupported modes without changing runtime', t => {
  const { service, file } = fixture(t, 'HARNESS_PIPELINE=v1\n');
  const runtime = process.env.HARNESS_PIPELINE;
  let before = service.get();
  const field = before.fields.find(field => field.key === 'HARNESS_PIPELINE');
  assert.equal(field.type, 'select');
  assert.equal(field.group, 'Điều phối agent và giới hạn');
  assert.equal(field.value, 'v1');
  assert.deepEqual(field.options, ['v1', 'v2']);
  for (const value of ['v2', 'v1']) {
    const saved = service.save({ revision: before.revision, values: { HARNESS_PIPELINE: value } });
    assert.equal(saved.restartRequired, true);
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp('^HARNESS_PIPELINE=' + value + '$', 'm'));
    before = service.get();
    assert.equal(before.fields.find(field => field.key === 'HARNESS_PIPELINE').value, value);
    assert.equal(process.env.HARNESS_PIPELINE, runtime);
  }
  const unchanged = fs.readFileSync(file, 'utf8');
  for (const value of ['v3', 'auto', '']) {
    assert.throws(() => service.save({ revision: before.revision, values: { HARNESS_PIPELINE: value } }), error => error.statusCode === 400);
    assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
  }
});

test('an unset harness flag displays the v1 runtime fallback without enabling v2', t => {
  const { service } = fixture(t, '');
  const field = service.get().fields.find(field => field.key === 'HARNESS_PIPELINE');
  assert.equal(field.value, 'v1');
  assert.equal(field.source, 'Mặc định');
});

test('settings no longer offer the removed legacy routing, tool loop and local harness switches', t => {
  const removed = ['GOVERNED_CONTROLLER_MODE', 'AGENT_CORE_ENABLED', 'AI_MAX_TOOL_ITERATIONS', 'CHAT_ROUTING_MODE', 'CHAT_ROUTING_LOCAL_MODEL',
    'CHAT_QUICK_GREETING_ENABLED', 'LOCAL_MODEL_HARNESS_ENABLED', 'LOCAL_MODEL_SCHEMA_SELECTOR_ENABLED', 'MODEL_DATA_INTENT_PLANNER_ENABLED'];
  const { service, file } = fixture(t, 'GOVERNED_CONTROLLER_MODE=legacy\nCHAT_ROUTING_MODE=local_tev1\n');
  const fields = service.get().fields;
  for (const key of removed) assert.ok(!fields.some(field => field.key === key), key);
  assert.ok(!fields.some(field => field.group === 'Tương thích legacy'));
  for (const key of ['QDRANT_EXE', 'AI_MEMORY_RECENT_MESSAGES', 'AI_MEMORY_SUMMARY_CHARS', 'AI_DOCUMENT_CONTEXT_CHARS', 'AI_DOCUMENT_MIN_SCORE', 'AI_CONVERSATION_HISTORY', 'MEMORY_SEMANTIC_ROUTING_ENABLED']) {
    assert.ok(!fields.some(field => field.key === key), key);
  }
  // An old .env line is kept as written, but cannot be changed through settings.
  for (const key of ['GOVERNED_CONTROLLER_MODE', 'CHAT_ROUTING_MODE']) {
    assert.throws(() => service.save({ revision: service.get().revision, values: { [key]: 'agent' } }), error => error.statusCode === 400);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'GOVERNED_CONTROLLER_MODE=legacy\nCHAT_ROUTING_MODE=local_tev1\n');
});

test('settings hide unused keys and expose the real embedding switch', t => {
  const { service, file } = fixture(t, 'EMBEDDING_ENABLED=true\nAI_MEMORY_SUMMARY_CHARS=4000\n');
  const before = service.get();
  assert.equal(before.fields.find(field => field.key === 'EMBEDDING_ENABLED').type, 'boolean');
  assert.ok(!before.fields.some(field => field.key === 'AI_MEMORY_SUMMARY_CHARS'));
  service.save({ revision: before.revision, values: { EMBEDDING_ENABLED: 'false' } });
  assert.match(fs.readFileSync(file, 'utf8'), /EMBEDDING_ENABLED=false/);
  assert.throws(() => service.save({ revision: service.get().revision, values: { AI_MEMORY_SUMMARY_CHARS: '5000' } }));
});
test('settings expose and persist the workflow feature switch', t => {
  const { service, file } = fixture(t, 'WORKFLOW_PLUGINS_ENABLED=false\n');
  const before = service.get();
  const field = before.fields.find(field => field.key === 'WORKFLOW_PLUGINS_ENABLED');
  assert.equal(field.type, 'boolean');
  assert.equal(field.group, 'Mẫu nghiệp vụ');
  assert.equal(field.value, 'false');
  assert.throws(() => service.save({ revision: before.revision, values: { WORKFLOW_PLUGINS_ENABLED: 'yes' } }));
  service.save({ revision: before.revision, values: { WORKFLOW_PLUGINS_ENABLED: 'true' } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'WORKFLOW_PLUGINS_ENABLED=true\n');
});
test('settings preserve unknown secrets and comments while updating duplicate keys', t => {
  const { service, file } = fixture(t, '# Config\r\nPORT=3000\r\nPRIVATE_TOKEN=secret-value\r\nPORT=3001\r\n');
  const before = service.get();
  assert.ok(!JSON.stringify(before).includes('secret-value'));
  service.save({ revision: before.revision, values: { PORT: '4000' } });
  assert.equal(fs.readFileSync(file, 'utf8'), '# Config\r\nPORT=4000\r\nPRIVATE_TOKEN=secret-value\r\nPORT=4000\r\n');
});
test('settings reject unknown keys, injection and invalid ranges atomically', t => {
  const { service, file } = fixture(t, 'PORT=3000\n');
  for (const values of [{ NODE_OPTIONS: '--inspect' }, { PORT: '3000\nEVIL=yes' }, { PORT: '99999' }, { AI_DOCUMENT_MIN_SCORE: '2' }, { QDRANT_URL: 'http://user:pass@localhost' }]) {
    assert.throws(() => service.save({ revision: service.get().revision, values }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'PORT=3000\n');
  }
});
test('settings hide and reject the obsolete Qdrant executable while allowing its Docker endpoint', t => {
  const { service, file } = fixture(t, 'QDRANT_EXE=D:\\Qdrant\\qdrant.exe\n');
  assert.ok(!JSON.stringify(service.get()).includes('QDRANT_EXE'));
  assert.throws(() => service.save({ revision: service.get().revision, values: { QDRANT_EXE: 'E:\\Apps\\Qdrant\\qdrant.exe' } }), error => error.statusCode === 400);
  assert.equal(fs.readFileSync(file, 'utf8'), 'QDRANT_EXE=D:\\Qdrant\\qdrant.exe\n');
  service.save({ revision: service.get().revision, values: { QDRANT_URL: 'http://127.0.0.1:6333' } });
  assert.ok(fs.readFileSync(file, 'utf8').includes('QDRANT_URL=http://127.0.0.1:6333'));
});
test('settings reject stale revisions and redact credentials in URLs', t => {
  const { service, file } = fixture(t, 'QDRANT_URL=http://user:secret@localhost\n');
  const before = service.get();
  assert.ok(!JSON.stringify(before).includes('secret'));
  fs.appendFileSync(file, 'PORT=3002\n');
  assert.throws(() => service.save({ revision: before.revision, values: { PORT: '4000' } }), error => error.statusCode === 409);
});

test('settings expose safe env options with example defaults and preserve CORS lists', t => {
  const { service } = fixture(t, 'CORS_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000\nSQL_JOIN_PLANNER_ENABLED=true\n');
  const fields = service.get().fields;
  const byKey = key => fields.find(field => field.key === key);
  assert.equal(byKey('CORS_ALLOWED_ORIGINS').value, 'http://127.0.0.1:3000,http://localhost:3000');
  assert.equal(byKey('CORS_ALLOWED_ORIGINS').type, 'text');
  assert.equal(byKey('SQL_JOIN_PLANNER_ENABLED').value, 'true');
  assert.equal(byKey('AI_PROVIDER_MAX_MODEL_CALLS').value, '12');
  assert.equal(byKey('APP_STORAGE_BACKEND').type, 'select');
  assert.equal(byKey('AI_DOCUMENT_CONTEXT_CHARS'), undefined);
});
