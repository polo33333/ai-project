'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
async function main() {
  const base = 'http://localhost:5500', env = JSON.parse(fs.readFileSync('artifacts/document-ai-eval/environment.json', 'utf8'));
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(0, 'utf8') });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') }, records = [];
  const sessionId = 'chart-repair-' + crypto.randomUUID();
  try {
    const questions = ['vẽ biểu đồ sản lượng điện bán ra trong 7 tháng', 'vẽ biểu đồ sản lượng điện bán ra trong 7 tháng gần nhất có dữ liệu'];
    for (const question of process.argv[2] === 'one' ? questions.slice(0, 1) : questions) {
      const response = await fetch(base + '/api/intelligent-core/chat', { method: 'POST', headers, body: JSON.stringify({ question, sessionId,
        history: [], providerId: env.provider.id, dbSourceId: env.dbSource.id, webSearch: false, knowledgeSearchEnabled: true }), signal: AbortSignal.timeout(180000) });
      const result = await response.json(); records.push({ question, result });
      fs.writeFileSync('artifacts/semantic-model/chart-repair-live.json', JSON.stringify({ records }, null, 2));
      console.log(JSON.stringify({ question, status: result.completionStatus, chart: Boolean(result.chartSpec), labels: result.chartSpec?.data?.labels,
        reply: result.reply, sql: result.generatedSql, errors: result.toolCalls?.filter(call => !call.success).map(call => ({ name: call.toolName, error: call.error })) }));
    }
    const history = await (await fetch(base + '/api/chat-history', { headers })).json();
    const ids = new Set(records.map(record => record.result.auditId));
    const audits = history.filter(item => ids.has(item.id)).map(item => ({ id: item.id, diagnostics: item.requestPayload?.diagnostics }));
    fs.writeFileSync('artifacts/semantic-model/chart-repair-audits.json', JSON.stringify(audits, null, 2));
    console.log(JSON.stringify(audits.map(item => ({ id: item.id, stop: item.diagnostics?.stopReason, errors: item.diagnostics?.steps?.filter(step => step.type === 'PROVIDER_ERROR') }))));
  } finally { await fetch(base + '/api/auth/logout', { method: 'POST', headers }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
