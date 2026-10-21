'use strict';
function describe(error, pool) {
  const message = String(error?.message || '').toLowerCase();
  const connectionTimeout = message.includes('connection timeout') || message.includes('timeout exceeded when trying to connect');
  return { code: connectionTimeout ? 'DB_CONNECTION_TIMEOUT' : error?.code || error?.name || 'ERROR',
    ...(pool ? { pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: pool.options?.max } } : {}) };
}
module.exports = { describe };
