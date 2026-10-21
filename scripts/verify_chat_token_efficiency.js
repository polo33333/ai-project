'use strict';
const fs = require('node:fs');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = 'http://localhost:5500';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const snapshot = JSON.parse(fs.readFileSync('artifacts/agent-acceptance/latest-twenty-tokens.private.json'));
  const original = snapshot[0];
  const results = [];
  try {
    const sessions = await (await fetch(base + '/api/page-chat/sessions', { headers })).json();
    const current = sessions.sessions.find(session => session.id === original.requestPayload.sessionId);
    const previousHistory = current?.history.slice(0, -2).slice(-original.requestPayload.historyCount) || [];
    for (const [name, history] of [['fresh', []], ['with-history', previousHistory]]) {
      const response = await fetch(base + '/api/intelligent-core/chat', { method: 'POST', headers,
        body: JSON.stringify({ question: original.question, history, sessionId: 'token-eval-' + require('node:crypto').randomUUID(), providerId: original.requestPayload.providerId, dbSourceId: original.requestPayload.contextSelection.dbSourceId, webSearch: false }), signal: AbortSignal.timeout(150000) });
      const result = await response.json();
      results.push({ name, historyCount: history.length, http: response.status, result });
      fs.writeFileSync('artifacts/agent-acceptance/token-efficiency-replay.private.json', JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ name, historyCount: history.length, status: result.completionStatus, tokens: result.tokenUsage, sql: result.generatedSql, reply: result.reply }));
    }
    const audits = await (await fetch(base + '/api/chat-history', { headers })).json();
    fs.writeFileSync('artifacts/agent-acceptance/token-efficiency-audits.private.json', JSON.stringify(audits.filter(item => results.some(result => result.result.auditId === item.id)), null, 2));
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
