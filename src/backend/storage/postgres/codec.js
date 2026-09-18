'use strict';

const { protect, encrypt, decrypt } = require('./crypto');
const encryptedTables = new Set(['auth_sessions', 'api_keys', 'ai_providers', 'data_sources', 'mcp_servers', 'workflows']);

function encode(table, id, value) {
  return encryptedTables.has(table) ? encrypt(value, `${table}/${id}`) : protect(value, `${table}/${id}`);
}
function decode(table, id, value) {
  return encryptedTables.has(table) ? decrypt(value, `${table}/${id}`) : protect(value, `${table}/${id}`, true);
}

module.exports = { encode, decode };
