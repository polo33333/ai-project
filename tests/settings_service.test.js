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
test('settings allow administrators to update the Qdrant executable path', t => {
  const { service, file } = fixture(t, 'QDRANT_EXE=D:\\Qdrant\\qdrant.exe\n');
  service.save({ revision: service.get().revision, values: { QDRANT_EXE: 'E:\\Apps\\Qdrant\\qdrant.exe' } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'QDRANT_EXE=E:\\Apps\\Qdrant\\qdrant.exe\n');
});
test('settings reject stale revisions and redact credentials in URLs', t => {
  const { service, file } = fixture(t, 'QDRANT_URL=http://user:secret@localhost\n');
  const before = service.get();
  assert.ok(!JSON.stringify(before).includes('secret'));
  fs.appendFileSync(file, 'PORT=3002\n');
  assert.throws(() => service.save({ revision: before.revision, values: { PORT: '4000' } }), error => error.statusCode === 409);
});
