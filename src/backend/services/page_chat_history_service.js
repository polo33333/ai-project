'use strict';
const storage = require('../storage');
const { transaction } = require('../storage/postgres/pool');
const { encrypt, decrypt } = require('../storage/postgres/crypto');
const fail = (message, statusCode=400) => { throw Object.assign(new Error(message), {statusCode}); };
const context = (owner,id) => `ui-chat/${owner}/${id}`;
function pool() {
  if (!storage.enabled()) fail('PAGE_CHAT_REQUIRES_POSTGRES',503);
  return storage.getPool();
}
async function list(owner) {
  const rows = (await pool().query('SELECT id,version,payload FROM app.ui_chat_sessions WHERE account_id=$1 ORDER BY updated_at DESC,id',[owner])).rows;
  return rows.map(row => ({...decrypt(row.payload,context(owner,row.id)),version:row.version}));
}
async function save(owner, {changes=[],deleted=[]}={}) {
  if (!Array.isArray(changes)||!Array.isArray(deleted)||changes.length+deleted.length>500) fail('INVALID_CHAT_CHANGES');
  const seen = new Set();
  for (const item of [...changes,...deleted]) {
    if (!item || typeof item.id!=='string'||!/^[-a-zA-Z0-9_:]{1,150}$/.test(item.id)||seen.has(item.id)) fail('INVALID_CHAT_ID');
    seen.add(item.id);
    if (!Number.isInteger(item.version)||item.version<0) fail('INVALID_CHAT_VERSION');
  }
  for (const session of changes) {
    if (typeof session.title!=='string'||session.title.length>200||!Array.isArray(session.messages)||!Array.isArray(session.history)||Buffer.byteLength(JSON.stringify(session))>4*1024*1024) fail('INVALID_CHAT_SESSION');
  }
  return transaction(pool(),async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['ui-chat:'+owner]);
    const versions={};
    for (const item of deleted) {
      const result=await client.query('DELETE FROM app.ui_chat_sessions WHERE account_id=$1 AND id=$2 AND version=$3 RETURNING id',[owner,item.id,item.version]);
      if (!result.rowCount) fail('CHAT_HISTORY_CONFLICT',409);
    }
    for (const session of changes) {
      const {version,...payload}=session;
      const sealed=JSON.stringify(encrypt(payload,context(owner,session.id)));
      const result=version===0
        ? await client.query('INSERT INTO app.ui_chat_sessions(account_id,id,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING version',[owner,session.id,sealed])
        : await client.query('UPDATE app.ui_chat_sessions SET payload=$4,version=version+1,updated_at=now() WHERE account_id=$1 AND id=$2 AND version=$3 RETURNING version',[owner,session.id,version,sealed]);
      if (!result.rowCount) fail('CHAT_HISTORY_CONFLICT',409);
      versions[session.id]=result.rows[0].version;
    }
    return {versions};
  });
}
module.exports={list,save};
