'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { loadEnvironment } = require('../../src/backend/storage/postgres/config');
const { createPool, transaction } = require('../../src/backend/storage/postgres/pool');
const { migrate } = require('../../src/backend/storage/postgres/migrate');
const { grantRuntime } = require('../../src/backend/storage/postgres/permissions');
const { PostgresRepository } = require('../../src/backend/storage/postgres/repository');
const { snapshot, readSnapshot, inventory } = require('./snapshot');
const { importSnapshot, verifySnapshot } = require('./transfer');
const { canonical } = require('./model');
const root = path.resolve(__dirname, '../..');

async function portIsOpen(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function updateBackend(file) {
  let contents;
  try { contents=await fs.readFile(file,'utf8'); } catch(error) { if(error.code!=='ENOENT')throw error; contents=''; }
  contents=/^\s*APP_STORAGE_BACKEND\s*=/m.test(contents)?contents.replace(/^\s*APP_STORAGE_BACKEND\s*=.*$/m,'APP_STORAGE_BACKEND=postgres'):contents+'\nAPP_STORAGE_BACKEND=postgres\n';
  const temporary=file+'.cutover.tmp';
  await fs.writeFile(temporary,contents,{flag:'wx',mode:0o600});
  await fs.rename(temporary,file);
}

async function main() {
  loadEnvironment(root);
  if(await portIsOpen(process.env.HOST==='0.0.0.0'?'127.0.0.1':process.env.HOST||'127.0.0.1',Number(process.env.PORT||3000))) {
    throw new Error('Stop the app server and all maintenance writers before cutover. The configured HTTP port is still listening.');
  }
  const pool=createPool();
  const dataDirectory=path.resolve(process.env.KNOWLEDGEHUB_DATA_DIR||path.join(root,'data'));
  let report;
  try {
    await migrate(pool); await grantRuntime(pool);
    const state=(await pool.query('SELECT mode FROM app.storage_state')).rows[0];
    if(state?.mode!=='staging')throw new Error('Cutover only accepts a staging database; a live database will never be overwritten.');
    const backupRoot=path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR||path.join(root,'backups'));
    await fs.mkdir(backupRoot,{recursive:true});
    const dump=path.join(backupRoot,`pre-cutover-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
    await require('./backup').docker('pg_dump',['--format=custom','--no-owner','--no-acl','--schema=app'],{output:dump});
    const bytes=await fs.readFile(dump);
    await fs.writeFile(dump+'.manifest.json',JSON.stringify({version:1,sha256:require('../../src/backend/storage/postgres/crypto').sha256(bytes),bytes:bytes.length,encryptionKeyRequired:true},null,2),{flag:'wx',mode:0o600});
    const final=await snapshot(dataDirectory,process.env.KNOWLEDGEHUB_BACKUP_DIR||path.join(root,'backups'));
    const loaded=await readSnapshot(final.directory);
    const batch=(await pool.query('SELECT snapshot_hash FROM app.import_batches')).rows;
    if(batch.length===0)await importSnapshot(pool,loaded);
    else {
      const manifests=await pool.query('SELECT snapshot_hash FROM app.import_batches');
      if(manifests.rows.length!==1)throw new Error('Unexpected import history; refusing cutover.');
      // To reconcile final JSON deltas, first verify the original imported
      // snapshot still matches staging. Never replace live data with JSON.
      const backups=path.resolve(process.env.KNOWLEDGEHUB_BACKUP_DIR||path.join(root,'backups'));
      let original;
      for(const entry of await fs.readdir(backups,{withFileTypes:true})) {
        if(!entry.isDirectory()||!entry.name.startsWith('postgres-import-'))continue;
        const candidate=path.join(backups,entry.name);
        const manifest=JSON.parse(await fs.readFile(path.join(candidate,'manifest.json'),'utf8'));
        if(manifest.snapshotHash===manifests.rows[0].snapshot_hash){original=await readSnapshot(candidate);break;}
      }
      if(!original)throw new Error('Original import snapshot not found. Cutover cannot safely reconcile staging data.');
      await verifySnapshot(pool,original);
      if(canonical([...original.documents])!==canonical([...loaded.documents])) {
        const repo=new PostgresRepository(pool);
        const before=await repo.snapshot();
        const documents=new Map(loaded.documents);
        // Adopt unchanged legacy record IDs for records without public IDs.
        const {sources}=require('../../src/backend/storage/postgres/catalog');
        const {identity}=require('../../src/backend/storage/postgres/repository');
        for(const source of sources.filter(source=>['array','wrapped'].includes(source.shape))) {
          const old=before.documents.get(source.file);
          const current=documents.get(source.file);
          if(!old||!current)continue;
          const previous=source.wrapper?old[source.wrapper]:old;
          const next=source.wrapper?current[source.wrapper]:current;
          for(const record of next)if(!source.idField||!record[source.idField]) {
            const match=previous.find(value=>canonical(value)===canonical(record));
            if(match?.[identity])Object.defineProperty(record,identity,{value:match[identity],configurable:true});
          }
        }
        await repo.commit({id:require('node:crypto').randomUUID(),baseline:before.documents,documents,dirty:new Set(documents.keys()),jobs:[]});
      }
      // Model identities for id-less records may have changed on reconciliation;
      // content comparison remains exact, all public IDs are preserved.
      const reconstructed=(await new PostgresRepository(pool).snapshot()).documents;
      for(const [file,value]of loaded.documents)if(canonical(reconstructed.get(file))!==canonical(value))throw new Error(`Final content verification failed: ${file}`);
    }
    if(canonical(await inventory(dataDirectory))!==canonical(final.manifest.files))throw new Error('JSON changed during cutover. Leave staging and retry after stopping writers.');
    if(!(await pool.query('SELECT 1 FROM app.accounts LIMIT 1')).rowCount)throw new Error('No imported accounts; refusing cutover.');
    await transaction(pool,async client=>{
      const result=await client.query("UPDATE app.storage_state SET mode='live' WHERE mode='staging' RETURNING mode");
      if(result.rowCount!==1)throw new Error('Unexpected cutover state.');
    });
    await updateBackend(path.join(root,'.env'));
    await updateBackend(path.join(root,'.env.postgres'));
    report={cutover:true,backend:'postgres',snapshot:final.directory,verifiedFiles:loaded.documents.size,
      sourceDataPreserved:true,createdAt:new Date().toISOString(),counts:Object.fromEntries(Object.entries(loaded.model.rows).map(([table,rows])=>[table,rows.length]))};
    await fs.writeFile(path.join(final.directory,'cutover-report.json'),JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify(report,null,2));
  } finally {await pool.end();}
}
main().catch(error=>{console.error(error.code?`Cutover failed (${error.code}). Data retained; check state/config before retry.`:error.message);process.exitCode=1;});
