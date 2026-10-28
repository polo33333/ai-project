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

test('a prepended chat run is inserted without loading or rewriting the stored history', async () => {
  const queries = [];
  const client = { release() {}, async query(sql,params=[]) {
    queries.push({sql,params});
    if (sql.includes('FROM app.chat_sessions WHERE id=$1')) return {rows:[{}],rowCount:params[0]==='acc__s1'?1:0};
    return {rows:[],rowCount:0};
  }};
  const repository = new PostgresRepository({connect:async()=>client});
  const record = {id:'run-new',timestamp:'10:00:00 29/10/2026',question:'hi',status:'SUCCESS',
    requestPayload:{memoryDecision:{accountId:'acc',sessionId:'s1'},toolCalls:[{name:'search_schema'},{name:'execute_sql_query'}]}};
  await repository.commit({id:'operation',dirty:new Set(),baseline:new Map(),documents:new Map(),jobs:[],prepends:[{file:'chat_history.json',record,limit:5000}]});
  assert.ok(!queries.some(q=>q.sql.startsWith('SELECT * FROM app.')), 'no store is loaded');
  assert.ok(queries.filter(q=>q.sql.includes('FROM app.domain_stores')).every(q=>q.params[0].length===0));
  const order=queries.map(q=>q.sql);
  const shift=order.indexOf('UPDATE app.chat_runs SET ordinal=ordinal+1');
  const insert=order.findIndex(sql=>sql.startsWith('INSERT INTO app.chat_runs'));
  const trim=order.indexOf('DELETE FROM app.chat_runs WHERE ordinal>=$1');
  assert.ok(shift>=0&&insert>shift&&trim>insert, 'shift, insert, then trim');
  assert.deepEqual(queries[trim].params,[5000]);
  const row=queries[insert];
  const columns=row.sql.slice(row.sql.indexOf('(')+1,row.sql.indexOf(')')).split(',');
  const value=name=>row.params[columns.indexOf(name)];
  assert.equal(value('id'),'run-new');
  assert.equal(value('ordinal'),0);
  assert.equal(value('session_id'),'acc__s1');
  assert.equal(value('completion_status'),'SUCCESS');
  assert.equal(queries.filter(q=>q.sql.startsWith('INSERT INTO app.tool_executions')).length,2);
  assert.ok(queries.some(q=>q.sql.includes('pg_advisory_xact_lock')));
});

test('saving feedback resolves its run by id without loading the chat history', async () => {
  const documents = new Map([['chat_feedback.json', []]]);
  const queries = [];
  const client = { release() {}, async query(sql,params=[]) {
    queries.push({sql,params});
    if (sql.includes('FROM app.domain_stores')) return {rows:[]};
    if (sql.startsWith('SELECT id FROM app.chat_runs')) return {rows:[{id:'run-1'}]};
    return {rows:[],rowCount:0};
  }};
  const repository = new PostgresRepository({connect:async()=>client});
  const proposed = [{id:'f1',auditId:'run-1',rating:'like'},{id:'f2',auditId:'trimmed-run',rating:'dislike'}];
  await repository.commit({id:'operation',dirty:new Set(['chat_feedback.json']),baseline:documents,documents:new Map([['chat_feedback.json',proposed]]),jobs:[]});
  assert.ok(!commitFiles(new Set(['chat_feedback.json'])).includes('chat_history.json'));
  assert.ok(!queries.some(q=>q.sql.startsWith('SELECT * FROM app.chat_runs')), 'chat history is not loaded');
  assert.deepEqual(queries.find(q=>q.sql.startsWith('SELECT id FROM app.chat_runs')).params[0].sort(),['run-1','trimmed-run']);
  const inserts=queries.filter(q=>q.sql.startsWith('INSERT INTO app.chat_feedback'));
  const runId=insert=>{const columns=insert.sql.slice(insert.sql.indexOf('(')+1,insert.sql.indexOf(')')).split(',');return insert.params[columns.indexOf('run_id')];};
  assert.deepEqual(inserts.map(runId),['run-1',null]);
});
