'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildModel } = require('../scripts/postgres/model');
const { PostgresRepository, commitFiles } = require('../src/backend/storage/postgres/repository');
const { encode } = require('../src/backend/storage/postgres/codec');
process.env.APP_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

test('commit scope includes normalization parents without unrelated stores', () => {
  assert.deepEqual(commitFiles(new Set(['dictionary.json'])), ['dictionary.json','db_sources.json']);
  assert.ok(commitFiles(new Set(['sessions.json'])).includes('accounts.json'));
  assert.ok(commitFiles(new Set(['accounts.json'])).includes('account_roles.json'));
  assert.ok(commitFiles(new Set(['chat_history.json'])).includes('conversation_memory.json'));
  assert.deepEqual(commitFiles(new Set()), []);
});

test('saving a dictionary reads its source parents and never rewrites unrelated data', async () => {
  const documents = new Map([
    ['db_sources.json', [{id:'source',name:'SQL'}]],
    ['dictionary.json', [{tableId:'table',tableName:'Orders',dbSourceId:'source',columns:[{columnName:'ID'}]}]],
    ['chat_history.json', [{id:'history',question:'Keep history'}]]
  ]);
  const model = buildModel(documents);
  const queries = [];
  const client = { release() {}, async query(sql,params=[]) {
    queries.push({sql,params});
    if (sql.includes('FROM app.domain_stores')) return {rows:model.files.filter(file=>params[0].includes(file.file)).map(file=>({file:file.file,root:file.root}))};
    if (sql.startsWith('SELECT * FROM app.')) {
      const table=sql.split('app.')[1].split(' ')[0];
      return {rows:model.rows[table].map(row=>({...structuredClone(row),payload:encode(table,row.id,row.payload)}))};
    }
    return {rows:[],rowCount:0};
  }};
  const repository = new PostgresRepository({connect:async()=>client});
  const proposed = structuredClone(documents.get('dictionary.json'));
  proposed[0].description='Updated';
  await repository.commit({id:'operation',dirty:new Set(['dictionary.json']),baseline:documents,documents:new Map([['dictionary.json',proposed]]),jobs:[]});
  assert.deepEqual(queries.find(q=>q.sql.includes('FROM app.domain_stores')).params[0],['dictionary.json','db_sources.json']);
  assert.ok(!queries.some(q=>q.sql.includes('app.chat_runs')));
  assert.ok(!queries.some(q=>q.sql.startsWith('UPDATE app.data_sources')));
  const update=queries.find(q=>q.sql.startsWith('UPDATE app.dictionary_tables SET'));
  assert.ok(update);
  assert.ok(update.params.includes('source'), 'data source foreign key remains attached');
  assert.ok(queries.some(q=>q.sql.includes('pg_advisory_xact_lock')), 'concurrent merge remains serialized');
});
