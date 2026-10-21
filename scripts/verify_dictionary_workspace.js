'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
async function main() {
  const base = 'http://localhost:5500';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(0, 'utf8') });
  assert.equal(login.status, 200, 'LOGIN_FAILED');
  const headers = { Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const records = [], routes = ['/api/dictionary/workspace','/api/glossary','/api/sql/sources','/api/dictionary/workspace','/api/dictionary/sync-status'];
  const runId = process.argv[2];
  if (runId) routes.push('/api/automation-runs/' + encodeURIComponent(runId), '/api/automation-runs/' + encodeURIComponent(runId) + '/events');
  try {
    for (let batch = 0; batch < 6; batch++) {
      await Promise.all(routes.map(async path => {
        const start = Date.now(), response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
        const data = path.endsWith('/events') ? await response.text() : await response.json();
        records.push({ path, status: response.status, durationMs: Date.now() - start });
        assert.equal(response.status, 200, path);
        if (path.endsWith('/workspace')) {
          assert.ok(Array.isArray(data.tables) && Array.isArray(data.relationships) && data.domains && typeof data.domains === 'object');
        }
      }));
    }
    const report = { requests: records.length, passed: records.filter(r => r.status === 200).length,
      maxMs: Math.max(...records.map(r => r.durationMs)), concurrency: routes.length, records };
    fs.writeFileSync(`artifacts/semantic-model/${runId ? 'workflow-poll-workspace-live' : 'dictionary-workspace-live'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, records: undefined }));
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
