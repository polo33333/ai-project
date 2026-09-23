'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTlsConfig } = require('../src/backend/services/tls_config');

test('HTTPS is optional and requires a matching certificate and key configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-tls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(loadTlsConfig({}, root), null);
  assert.throws(() => loadTlsConfig({ HTTPS_CERT_FILE: 'server.crt' }, root), /both HTTPS_CERT_FILE and HTTPS_KEY_FILE/);
  fs.writeFileSync(path.join(root, 'server.crt'), 'certificate');
  fs.writeFileSync(path.join(root, 'server.key'), 'private key');
  const config = loadTlsConfig({ HTTPS_CERT_FILE: 'server.crt', HTTPS_KEY_FILE: 'server.key' }, root);
  assert.equal(config.cert.toString(), 'certificate');
  assert.equal(config.key.toString(), 'private key');
  assert.throws(() => loadTlsConfig({ HTTPS_CERT_FILE: 'missing.crt', HTTPS_KEY_FILE: 'server.key' }, root), /Cannot read HTTPS_CERT_FILE/);
});
