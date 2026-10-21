'use strict';
const fs = require('node:fs');
const { verify } = require('../src/backend/governance/replay');
const filename = process.argv[2];
if (!filename) { console.error('Usage: npm run eval:governed:replay -- <audit-json-file>'); process.exitCode = 2; }
else {
  const audits = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(audits) || audits.length > 10000) throw new Error('Expected at most 10000 audit records.');
  const results = audits.map(verify), counts = Object.fromEntries(['passed', 'failed', 'unavailable'].map(status => [status, results.filter(result => result.status === status).length]));
  console.log(JSON.stringify({ reportVersion: '1', mode: 'offline_replay', counts, results }, null, 2));
  if (counts.failed || counts.unavailable) process.exitCode = 1;
}
