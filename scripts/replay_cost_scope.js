'use strict';
const fs = require('node:fs');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = 'http://localhost:5500';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  try {
    const old = JSON.parse(fs.readFileSync('artifacts/agent-acceptance/cost-history.private.json')).find(item => item.question === 'thống kê chi phí vận hành di tu cơ sở hạ tầng của điện bán');
    const response = await fetch(base + '/api/intelligent-core/chat', { method: 'POST', headers, body: JSON.stringify({ question: old.question, sessionId: 'acceptance-cost-' + require('node:crypto').randomUUID(), history: [], providerId: old.requestPayload.providerId, dbSourceId: old.requestPayload.contextSelection.dbSourceId, webSearch: false }), signal: AbortSignal.timeout(150000) });
    const result = await response.json();
    fs.writeFileSync('artifacts/agent-acceptance/cost-scoped-replay.private.json', JSON.stringify(result, null, 2));
    const history = await (await fetch(base + '/api/chat-history', { headers })).json();
    const audit = history.find(item => item.id === result.auditId);
    fs.writeFileSync('artifacts/agent-acceptance/cost-scoped-audit.private.json', JSON.stringify(audit, null, 2));
    console.log(JSON.stringify({ status: result.completionStatus, reply: result.reply, sql: result.generatedSql, steps: audit?.requestPayload?.diagnostics?.steps.filter(step => step.type !== 'MODEL_USAGE') }));
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
