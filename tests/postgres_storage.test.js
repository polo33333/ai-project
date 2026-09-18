'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildModel, reconstruct, canonical, timestamp } = require('../scripts/postgres/model');
const { encode, decode, importSnapshot, verifySnapshot } = require('../scripts/postgres/transfer');
const { sha256 } = require('../src/backend/storage/postgres/crypto');

const key = crypto.randomBytes(32).toString('hex');
process.env.APP_DATA_ENCRYPTION_KEY = key;
function fixture() {
  return new Map([
    ['accounts.json', [{ id: 'a', username: 'admin', passwordHash: 'scrypt$existing$hash' }]],
    ['sessions.json', { 'opaque-session-token': { accountId: 'a', expiresAt: 2000000000000 } }],
    ['api_keys.json', [{ id: 'key', key: 'sensitive-api-key' }]],
    ['ai_providers.json', [{ id: 'provider', apiKey: 'provider-secret' }]],
    ['chat_history.json', [{ id: 'chat', timestamp: '14:04:39 15/9/2026', status: 'PARTIAL', question: 'Tiếng Việt', requestPayload: { toolCalls: [{ name: 'sql', output: [1,2] }] } }]],
    ['chat_feedback.json', [{ id: 'feedback', auditId: 'chat', rating: 'dislike' }]],
    ['dictionary.json', [{ tableId: 'table', columns: [{ columnId: 'column', columnName: 'Name' }] }]],
    ['conversation_memory.json', { extra: 'preserve-root', sessions: { 'a__s': { id: 's', accountId: 'a', messages: [{ role: 'user', content: 'Chào' }, { role: 'assistant', content: 'Xin chào' }], summary: { topic: 'test' }, pendingTurn: null }, old: { id: 'old', messages: [], summary: '' } } }],
    ['domain_aliases.json', { customer: ['khách hàng', 'KH'], empty: [] }],
    ['skills.json', { version: 2, skills: [{ id: 'skill', instructions: 'test' }] }]
  ]);
}
function snapshot(documents = fixture()) {
  return { model: buildModel(documents), manifest: { snapshotHash: sha256(canonical([...documents])) } };
}

test('normalized data round-trips Vietnamese, IDs, ordering, wrappers and empty arrays', () => {
  const input = fixture();
  const model = buildModel(input);
  assert.equal(model.rows.chat_messages.length, 2);
  assert.equal(model.rows.dictionary_columns.length, 1);
  assert.equal(model.rows.tool_executions.length, 1);
  assert.equal(model.rows.chat_sessions.find(row => row.id === 'old').owner_scope, 'legacy-unowned:old');
  for (const [file, value] of reconstruct(model)) assert.deepEqual(value, input.get(file));
});

test('Vietnamese timestamps use UTC+7 and invalid dates are not silently normalized', () => {
  assert.equal(timestamp('14:04:39 15/9/2026'), '2026-09-15T07:04:39.000Z');
  assert.equal(timestamp('14:04:39, 15/9/2026'), '2026-09-15T07:04:39.000Z');
  assert.equal(timestamp('14:04:39 31/2/2026'), null);
  assert.equal(timestamp('yesterday'), null);
});

test('credentials are encrypted and cannot be transplanted to another record', () => {
  for (const table of ['api_keys', 'auth_sessions', 'data_sources', 'ai_providers']) {
    const payload = { key: 'secret-value', password: 'secret-password' };
    const ciphertext = encode(table, 'one', payload);
    assert.ok(!JSON.stringify(ciphertext).includes('secret-value'));
    assert.deepEqual(decode(table, 'one', ciphertext), payload);
    assert.throws(() => decode(table, 'two', ciphertext));
  }
  const payload = { request: { headers: { Authorization: 'Bearer nested-secret' } } };
  const ciphertext = encode('chat_runs', 'one', payload);
  assert.ok(!JSON.stringify(ciphertext).includes('nested-secret'));
  assert.deepEqual(decode('chat_runs', 'one', ciphertext), payload);
});

test('duplicate IDs refuse import and orphaned references are preserved without invented parents', () => {
  assert.throws(() => buildModel(new Map([['accounts.json', [{id:'a'}, {id:'a'}]]])), /Duplicate identity/);
  const model = buildModel(new Map([['chat_feedback.json', [{ id:'f', auditId:'missing' }]]]));
  assert.equal(model.rows.chat_feedback[0].run_id, null);
  assert.equal(reconstruct(model).get('chat_feedback.json')[0].auditId, 'missing');
  assert.equal(model.warnings.length, 1);
});

test('PostgreSQL real import, rollback, encryption, idempotency and tamper detection', { skip: process.env.KNOWLEDGEHUB_TEST_POSTGRES !== '1' }, async t => {
  const { loadEnvironment } = require('../src/backend/storage/postgres/config');
  const { createPool } = require('../src/backend/storage/postgres/pool');
  const { migrate } = require('../src/backend/storage/postgres/migrate');
  loadEnvironment();
  const database = 'knowledgehub_test_' + crypto.randomBytes(8).toString('hex');
  assert.match(database, /^knowledgehub_test_[a-f0-9]+$/);
  const admin = createPool({ bootstrap: true });
  let pool;
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    pool = createPool({ bootstrap: true, database });
    await migrate(pool);
    assert.deepEqual(await migrate(pool), []);
    const input = snapshot();
    await t.test('a mid-import error rolls back every table and manifest', async () => {
      const broken = structuredClone(input);
      broken.model.rows.chat_runs[0].completion_status = null;
      await assert.rejects(importSnapshot(pool, broken));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.accounts')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.import_batches')).rows[0].n, 0);
    });
    await t.test('concurrent duplicate imports serialize and produce one batch', async () => {
      const results = await Promise.all([importSnapshot(pool, input), importSnapshot(pool, input)]);
      assert.equal(results.filter(result => result.alreadyImported).length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.import_batches')).rows[0].n, 1);
      assert.equal((await verifySnapshot(pool, input)).ok, true);
      const raw = JSON.stringify((await pool.query('SELECT * FROM app.auth_sessions')).rows);
      assert.ok(!raw.includes('opaque-session-token'));
      const account = JSON.stringify((await pool.query('SELECT * FROM app.accounts')).rows);
      assert.ok(!account.includes('scrypt$existing$hash'));
    });
    await t.test('other snapshots and live databases refuse imports', async () => {
      await assert.rejects(importSnapshot(pool, { ...input, manifest: { snapshotHash: 'different' } }), /another snapshot/);
      await pool.query("UPDATE app.storage_state SET mode='live'");
      await assert.rejects(importSnapshot(pool, input), /database is live/);
      await pool.query("UPDATE app.storage_state SET mode='staging'");
    });
    await t.test('verification detects field corruption, not merely row counts', async () => {
      await pool.query("UPDATE app.chat_messages SET payload = '{\"content\":\"corrupt\"}'::jsonb");
      await assert.rejects(verifySnapshot(pool, input), /verification failed/);
    });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }
});
