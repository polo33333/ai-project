'use strict';

const { Pool } = require('pg');
const { connectionConfig } = require('./config');

function createPool(options) {
  const pool = new Pool(connectionConfig(options));
  pool.on('error', error => console.error('[PostgreSQL] Idle connection failed:', error.code || 'CONNECTION_ERROR'));
  return pool;
}

async function transaction(pool, operation, { readOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { createPool, transaction };
