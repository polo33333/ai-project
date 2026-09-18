'use strict';

const crypto = require('node:crypto');
const storage = require('../index');
const { protect } = require('./crypto');
const owner = crypto.randomUUID();
let timer;
let running;
let stopped = true;

async function processOne() {
  const pool = storage.getPool();
  const result = await pool.query(`UPDATE app.outbox_jobs SET status='running', lease_owner=$1,
    lease_until=now()+interval '5 minutes', attempts=attempts+1, updated_at=now()
    WHERE id=(SELECT id FROM app.outbox_jobs
      WHERE (status='pending' AND available_at<=now()) OR (status='running' AND lease_until<now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [owner]);
  const job = result.rows[0];
  if (!job) return false;
  const renew = setInterval(() => pool.query("UPDATE app.outbox_jobs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_owner=$2", [job.id, owner]).catch(() => {}), 60000);
  renew.unref();
  try {
    const payload = protect(job.payload, `outbox/${job.id}`, true);
    const result = await storage.lease(`outbox-resource:${job.resource_id}`, () => storage.run(async () => {
      const library = require('../../knowledge_core/services/library_service');
      if (job.kind === 'document.ingest') await library.processQueuedDocument(job.resource_id, payload);
      else if (job.kind === 'document.delete') await library.removeQueuedFiles(job.resource_id, payload);
      else throw new Error('UNKNOWN_OUTBOX_JOB');
    }, { independent: true }));
    if (result?.skipped) throw new Error('RESOURCE_BUSY');
    await pool.query("UPDATE app.outbox_jobs SET status='done', lease_owner=null, lease_until=null, updated_at=now() WHERE id=$1 AND lease_owner=$2", [job.id, owner]);
  } catch (error) {
    await pool.query(`UPDATE app.outbox_jobs SET status=CASE WHEN attempts>=10 THEN 'failed' ELSE 'pending' END,
      available_at=now()+least(attempts*10,300)*interval '1 second', lease_owner=null, lease_until=null,
      last_error=$3, updated_at=now() WHERE id=$1 AND lease_owner=$2`, [job.id, owner, error.code || error.name || 'ERROR']);
    if (job.kind==='document.ingest') {
      const payload=protect(job.payload, `outbox/${job.id}`, true);
      await storage.run(() => {
        const library=require('../../knowledge_core/services/library_service');
        const document=library.findDocument(job.resource_id);
        if(document && (!payload.fingerprint || document.sourceFingerprint===payload.fingerprint)) {
          document.status=job.attempts>=10?'Lỗi xử lý':'Đang chờ thử lại';
          document.error=error.code || error.message || 'DOCUMENT_PROCESSING_FAILED';
          library.persist();
        }
      },{independent:true}).catch(failure=>console.error('[Outbox] Status update failed:',failure.code||failure.name));
    }
  } finally { clearInterval(renew); }
  return true;
}

function start() {
  if (!stopped) return;
  stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = processOne().catch(error => console.error('[Outbox] Failed:', error.code || error.name)).finally(() => { running = null; });
  };
  timer = setInterval(storage.detach(tick), 2000); timer.unref();
  storage.detach(tick)();
}
async function stop() { stopped = true; clearInterval(timer); if (running) await running; }
module.exports = { start, stop, processOne };
