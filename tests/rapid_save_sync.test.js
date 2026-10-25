const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeDocument } = require('../src/backend/storage/postgres/repository');
const qdrant = require('../src/backend/services/qdrant_service');
const source = { table: 'dictionary_tables', shape: 'array', idField: 'tableId' };
const baseline = () => [{ tableId: 't', columns: [{ columnName: 'A', description: 'old' }, { columnName: 'B', description: 'old' }] }];

test('concurrent metadata saves to different columns merge without dropping either edit', () => {
  const base = baseline(), proposed = baseline(), fresh = baseline();
  proposed[0].columns[0].description = 'first'; fresh[0].columns[1].description = 'second';
  const merged = mergeDocument(source, base, proposed, fresh);
  assert.deepEqual(merged[0].columns.map(x => x.description), ['first', 'second']);
});

test('concurrent incompatible changes to the same column remain conflicts', () => {
  const base = baseline(), proposed = baseline(), fresh = baseline();
  proposed[0].columns[0].description = 'first'; fresh[0].columns[0].description = 'second';
  assert.throws(() => mergeDocument(source, base, proposed, fresh), { code: 'DATA_CONFLICT' });
});

function service() {
  const instance = new qdrant.constructor();
  instance.embedTexts = async () => [[1, 0]];
  return instance;
}
const table = name => [{ tableName: name, isActive: true, columns: [] }];

test('embedding failure preserves the existing collection without writes or deletes', async () => {
  const instance = service(); const requests = [];
  instance.embedTexts = async () => { throw new Error('embedding offline'); };
  instance.request = async (...args) => { requests.push(args); return {}; };
  const result = await instance.syncTablesToQdrant(table('A'));
  assert.equal(result.success, false); assert.equal(requests.length, 0);
});

test('rapid vector syncs serialize and prune old points only after upsert succeeds', async () => {
  const instance = service(); const requests = []; let active = 0, maxActive = 0;
  instance.embedTexts = async () => { active++; maxActive = Math.max(active, maxActive); await new Promise(done => setImmediate(done)); active--; return [[1, 0]]; };
  instance.request = async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    return path === '/collections' ? { result: { collections: [{ name: instance.collectionName }] } } : { status: 'ok' };
  };
  const results = await Promise.all([instance.syncTablesToQdrant(table('A')), instance.syncTablesToQdrant(table('B'))]);
  assert.ok(results.every(x => x.success)); assert.equal(maxActive, 1);
  assert.equal(requests.some(x => x.method === 'DELETE'), false);
  const writes = requests.filter(x => x.method !== 'GET');
  assert.deepEqual(writes.map(x => x.method), ['PUT', 'POST', 'PUT', 'POST']);
  assert.equal(writes[0].body.points[0].payload.schemaSyncVersion, writes[1].body.filter.must_not[0].match.value);
  assert.notEqual(writes[0].body.points[0].payload.schemaSyncVersion, writes[2].body.points[0].payload.schemaSyncVersion);
});

test('failed upsert never prunes the previous vector snapshot', async () => {
  const instance = service(); let pruned = false;
  instance.request = async (path, method = 'GET') => {
    if (method === 'PUT') throw new Error('write failed');
    if (method === 'POST') pruned = true;
    return { result: { collections: [{ name: instance.collectionName }] } };
  };
  const result = await instance.syncTablesToQdrant(table('A'));
  assert.equal(result.success, false); assert.equal(pruned, false);
});


test('dictionary UI ignores a duplicate save and does not reopen a different table', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync('src/frontend/admin-client/js/modules/dictionary.js','utf8');
  const start = source.indexOf('function reconcileDictionaryPresentation(');
  const end = source.indexOf('async function saveDictionaryColumnDescription',start);
  let finish, calls = 0, drawerRenders = 0; const control = { disabled:false, isConnected:true };
  const button = { disabled:false, isConnected:true };
  const context = { window:{selectedDictionaryTableName:'A',selectedDictionaryTableId:'a',pendingDictionaryRelationships:[]},
    document:{getElementById:id=>id==='dictionary-save-all-button'?button:null, querySelectorAll:selector=>selector==='#dictionary-drawer .dictionary-field-relation-editor'?[]:selector.startsWith('#dictionary-drawer')?[control]:[]},
    findDictionaryTable:()=>({columns:[]}),getDictionaryTables:()=>[],renderDictionaryQuality(){},renderDataDictionary(){},renderDictionaryDrawer(){drawerRenders++;},showToast(){},
    fetch:()=>{calls++;return new Promise(done=>{finish=done;});} };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function readFieldRelationshipState('),source.indexOf('function editFieldRelationship(')),context);
  vm.runInContext(source.slice(start,end),context);
  const first = context.saveSelectedTableDescription(); await context.saveSelectedTableDescription();
  assert.equal(calls,1); assert.equal(control.disabled,true);
  context.window.selectedDictionaryTableName='B';context.window.selectedDictionaryTableId='b';
  finish({ok:true,json:async()=>({status:'success',tables:[],relationships:[],vectorSync:{scheduled:true}})});
  await first; assert.equal(drawerRenders,0);assert.equal(control.disabled,false);assert.equal(context.window.dictionarySavePending,false);
});

test('durable dictionary sync failure is retained for an outbox retry', async () => {
  const storage=require('../src/backend/storage');
  const dictionary=require('../src/backend/services/dictionary_service');
  const outbox=require('../src/backend/storage/postgres/outbox');
  const previous={getPool:storage.getPool,lease:storage.lease,run:storage.run,sync:dictionary.syncToQdrant};
  const queries=[];let first=true;
  storage.getPool=()=>({query:async(sql,args)=>{queries.push({sql,args});if(first){first=false;return {rows:[{id:'job',kind:'dictionary.sync',resource_id:'dictionary-schema',payload:{},attempts:1}]};}return {rows:[]};}});
  storage.lease=async(_,operation)=>operation();storage.run=async operation=>operation();
  dictionary.syncToQdrant=async()=>({success:false,error:'offline'});
  try {await outbox.processOne(); assert.ok(queries.some(x=>x.sql.includes("attempts>=10")&&x.args[2]==='VECTOR_SYNC_FAILED'));}
  finally {storage.getPool=previous.getPool;storage.lease=previous.lease;storage.run=previous.run;dictionary.syncToQdrant=previous.sync;}
});


test('concurrent bounded log writes can both trim the same oldest record', () => {
  const source={table:'system_logs',shape:'array',idField:'id'};
  const old={id:'old',message:'old'}, retained={id:'keep',message:'keep'};
  const merged=mergeDocument(source,[retained,old],[{id:'a',message:'a'},retained],[{id:'b',message:'b'},retained]);
  assert.deepEqual(new Set(merged.map(x=>x.id)),new Set(['a','b','keep']));
});


test('concurrent log retention stays bounded and keeps both newly written events', () => {
  const source={table:'system_logs',shape:'array',idField:'id'};
  const base=Array.from({length:500},(_,i)=>({id:'old-'+i}));
  const merged=mergeDocument(source,base,[{id:'new-a'},...base.slice(0,499)],[{id:'new-b'},...base.slice(0,499)]);
  assert.equal(merged.length,500);assert.ok(merged.some(x=>x.id==='new-a'));assert.ok(merged.some(x=>x.id==='new-b'));
});
