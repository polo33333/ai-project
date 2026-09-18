'use strict';

const { tables } = require('./catalog');
async function grantRuntime(pool) {
  await pool.query('GRANT USAGE ON SCHEMA app TO knowledgehub_runtime');
  for (const table of [...tables,'domain_stores','operation_commits','chat_request_receipts','worker_leases','outbox_jobs','ui_chat_sessions']) {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.${table} TO knowledgehub_runtime`);
  }
  await pool.query('GRANT SELECT ON app.schema_migrations, app.storage_state TO knowledgehub_runtime');
}
module.exports = { grantRuntime };
