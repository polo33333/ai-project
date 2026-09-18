'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

function loadEnvironment(root = path.resolve(__dirname, '../../../..')) {
  // Explicit process environment wins; no credentials are printed.
  for (const name of ['.env', '.env.postgres']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function connectionConfig({ bootstrap = false, runtime = false, database } = {}) {
  const env = process.env;
  const user = bootstrap ? env.POSTGRES_USER : runtime ? env.APP_PG_RUNTIME_USER : env.APP_PG_USER;
  const password = bootstrap ? env.POSTGRES_PASSWORD : runtime ? env.APP_PG_RUNTIME_PASSWORD : env.APP_PG_PASSWORD;
  if (!user || !password) throw new Error('PostgreSQL credentials are not configured.');
  return {
    host: env.APP_PG_HOST || '127.0.0.1', port: Number(env.APP_PG_PORT || 5432),
    database: database || env.APP_PG_DATABASE || env.POSTGRES_DB || 'knowledgehub_app',
    user, password, max: Number(env.APP_PG_POOL_MAX || 5),
    connectionTimeoutMillis: Number(env.APP_PG_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: 30000, statement_timeout: Number(env.APP_PG_STATEMENT_TIMEOUT_MS || 30000),
    application_name: 'knowledgehub-storage',
    ssl: env.APP_PG_SSL_CA_FILE ? { ca: fs.readFileSync(env.APP_PG_SSL_CA_FILE, 'utf8'), rejectUnauthorized: true } : false
  };
}

module.exports = { loadEnvironment, connectionConfig };
