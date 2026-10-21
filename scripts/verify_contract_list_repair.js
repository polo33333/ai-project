'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
async function main() {
  const base = 'http://localhost:5500', env = JSON.parse(fs.readFileSync('artifacts/document-ai-eval/environment.json', 'utf8'));
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(0, 'utf8') });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const records = [], sessionId = 'contract-list-repair-' + crypto.randomUUID();
  try {
    for (const mode of ['default_source', 'repeat_same_conversation', 'explicit_source']) {
      const response = await fetch(base + '/api/intelligent-core/chat', { method: 'POST', headers,
        body: JSON.stringify({ question: 'ds hđ', sessionId, history: [], providerId: env.provider.id,
          ...(mode === 'explicit_source' ? { dbSourceId: env.dbSource.id } : {}), webSearch: false, knowledgeSearchEnabled: true }), signal: AbortSignal.timeout(180000) });
      const result = await response.json();
      const sql = String(result.generatedSql || '').toLowerCase();
      const quality = { completed: result.completionStatus === 'SUCCESS', correctTable: sql.includes('t_contract'),
        noUnrequestedJoin: !sql.includes(' join '), hasContractNumber: (result.sqlExecutions?.at(-1)?.columns || []).includes('ContractNo') };
      records.push({ mode, quality, result });
      fs.writeFileSync('artifacts/semantic-model/contract-list-repair-live.json', JSON.stringify({ records }, null, 2));
      console.log(JSON.stringify({ mode, status: result.completionStatus, sql: result.generatedSql,
        quality, rows: result.sqlExecutions?.at(-1)?.rowCount, reply: result.reply, errors: result.toolCalls?.filter(call => !call.success).map(call => call.error), input: result.tokenUsage?.inputTokens }));
    }
    const history = await (await fetch(base + '/api/chat-history', { headers })).json(), ids = new Set(records.map(item => item.result.auditId));
    const audits = history.filter(item => ids.has(item.id)).map(item => ({ id: item.id, diagnostics: item.requestPayload?.diagnostics }));
    fs.writeFileSync('artifacts/semantic-model/contract-list-repair-audits.json', JSON.stringify(audits, null, 2));
    console.log(JSON.stringify(audits.map(item => ({ id: item.id, stop: item.diagnostics?.stopReason,
      steps: item.diagnostics?.steps?.filter(step => !['MODEL_USAGE', 'REQUEST_CONTRACT_CREATED'].includes(step.type)) }))));
    if (records.some(record => Object.values(record.quality).some(passed => !passed))) process.exitCode = 1;
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
