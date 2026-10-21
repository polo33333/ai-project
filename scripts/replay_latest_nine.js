'use strict';
// Explicit live acceptance replay. Credentials arrive on stdin, never in artifacts.
const fs = require('node:fs');
const crypto = require('node:crypto');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = 'http://localhost:5500';
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error(`LOGIN_HTTP_${login.status}`);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  if (process.argv.includes('--restart')) {
    const response = await fetch(`${base}/api/settings/restart`, { method: 'POST', headers });
    if (response.status !== 202) throw new Error(`RESTART_HTTP_${response.status}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try { ready = (await fetch(`${base}/`, { headers })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!ready) throw new Error('RESTART_NOT_READY');
  }
  const snapshot = JSON.parse(fs.readFileSync('artifacts/agent-acceptance/latest-nine.private.json', 'utf8'));
  const focused = process.argv.includes('--focused');
  const cases = process.argv.includes('--verify-two') ? [snapshot[5], snapshot[0]] : focused ? [snapshot[2], snapshot[1], snapshot[5], snapshot[0]] : snapshot.slice().reverse();
  const sessionId = `acceptance-nine-${crypto.randomUUID()}`, history = [], results = [];
  for (const [index, entry] of cases.entries()) {
    const payload = entry.requestPayload || {};
    const response = await fetch(`${base}/api/intelligent-core/chat`, { method: 'POST', headers,
      body: JSON.stringify({ question: entry.question, sessionId, history,
        providerId: payload.providerId, dbSourceId: payload.contextSelection?.dbSourceId,
        knowledgeSearchEnabled: true, webSearch: false }), signal: AbortSignal.timeout(150000) });
    const result = await response.json();
    results.push({ originalId: entry.id, question: entry.question, httpStatus: response.status, result });
    fs.writeFileSync(`artifacts/agent-acceptance/${focused ? 'nine-focused-replay' : 'nine-replay'}.private.json`, JSON.stringify({ sessionId, results }, null, 2));
    const reply = result.reply || result.replyText || result.message || '';
    history.push({ role: 'user', content: entry.question }, { role: 'assistant', content: reply });
    console.log(JSON.stringify({ case: index + 1, originalId: entry.id, status: result.status,
      disposition: result.answerEnvelope?.disposition, reply: reply.slice(0, 1800) }));
  }
  await fetch(`${base}/api/auth/logout`, { method: 'POST', headers });
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
