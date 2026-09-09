'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('provider DTO never exposes the original API key', () => {
  const manager = require('../src/backend/services/ai_provider_manager');
  const secret = 'sk-super-secret-value-that-must-not-leak';
  const dto = manager.publicProvider({ id: 'x', name: 'test', apiKey: secret });
  assert.equal(dto.apiKey, undefined);
  assert.equal(dto.hasApiKey, true);
  assert.equal(JSON.stringify(dto).includes(secret), false);
});

test('provider execution lookup retains credentials without exposing them in public DTOs', () => {
  const manager = require('../src/backend/services/ai_provider_manager');
  const provider = manager.getProvidersForExecution().find(item => item.apiKey);
  assert.ok(provider, 'test data must contain a credentialed provider');
  assert.equal(manager.getProviderForExecution(provider.id)?.apiKey, provider.apiKey);
  assert.equal(manager.getProviders().find(item => item.id === provider.id)?.apiKey, undefined);
});

test('web grounding detects an incorrect enterprise-scope refusal', () => {
  const { isWebScopeRefusal } = require('../src/backend/agent_core/harness/agent_harness');
  assert.equal(isWebScopeRefusal('Hệ thống dữ liệu nội bộ không được kết nối với thông tin thị trường theo thời gian thực.'), true);
  assert.equal(isWebScopeRefusal('Theo kết quả web, giá được cập nhật tại nguồn sau.'), false);
});

test('storage writes valid JSON atomically and leaves no temporary file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-storage-'));
  const script = "const S=require('./src/backend/utils/storage_helper'); S.saveJson('sample.json',{ok:true});";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, KNOWLEDGEHUB_DATA_DIR: directory }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'sample.json'), 'utf8')), { ok: true });
  assert.deepEqual(fs.readdirSync(directory), ['sample.json']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('corrupt persistent JSON fails visibly instead of silently returning defaults', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-storage-corrupt-'));
  fs.writeFileSync(path.join(directory, 'broken.json'), '{not-json');
  const result = spawnSync(process.execPath, ['-e', "require('./src/backend/utils/storage_helper').loadJson('broken.json', [])"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, KNOWLEDGEHUB_DATA_DIR: directory }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /broken\.json/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('fresh authentication store requires an explicit bootstrap secret', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-auth-'));
  const result = spawnSync(process.execPath, ['-e', "require('./src/backend/services/auth_service')"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, KNOWLEDGEHUB_DATA_DIR: directory, BOOTSTRAP_ADMIN_PASSWORD: '' }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOOTSTRAP_ADMIN_PASSWORD/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('legacy SHA-256 password is migrated to scrypt after login', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-auth-migrate-'));
  const crypto = require('node:crypto');
  const legacy = crypto.createHash('sha256').update('correct horse battery staple').digest('hex');
  fs.writeFileSync(path.join(directory, 'accounts.json'), JSON.stringify([{ id: 'u', username: 'u', role: 'user', isActive: true, passwordHash: legacy }]));
  const script = "const a=require('./src/backend/services/auth_service'); if(!a.login('u','correct horse battery staple')) process.exit(2);";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, KNOWLEDGEHUB_DATA_DIR: directory }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const accounts = JSON.parse(fs.readFileSync(path.join(directory, 'accounts.json'), 'utf8'));
  assert.match(accounts[0].passwordHash, /^scrypt\$/);
  fs.rmSync(directory, { recursive: true, force: true });
});
