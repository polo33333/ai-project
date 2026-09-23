'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadTlsConfig(env = process.env, root = process.cwd()) {
  const certFile = env.HTTPS_CERT_FILE;
  const keyFile = env.HTTPS_KEY_FILE;
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) throw new Error('HTTPS requires both HTTPS_CERT_FILE and HTTPS_KEY_FILE.');
  const read = (file, label) => {
    try { return fs.readFileSync(path.resolve(root, file)); }
    catch (error) { throw new Error(`Cannot read ${label}: ${error.message}`); }
  };
  return { cert: read(certFile, 'HTTPS_CERT_FILE'), key: read(keyFile, 'HTTPS_KEY_FILE') };
}

module.exports = { loadTlsConfig };
