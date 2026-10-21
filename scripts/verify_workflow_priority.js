'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
async function main() {
  const base = 'http://localhost:5500', env = JSON.parse(fs.readFileSync('artifacts/document-ai-eval/environment.json', 'utf8'));
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(0, 'utf8') });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const prefix = 'workflow-priority-' + crypto.randomUUID(), runs = new Set(), records = [];
  const save = () => fs.writeFileSync('artifacts/semantic-model/workflow-priority-live.json', JSON.stringify({ records }, null, 2));
  const ask = async (id, question, sessionId) => {
    const response = await fetch(base + '/api/intelligent-core/chat', { method: 'POST', headers, body: JSON.stringify({ question, sessionId, history: [],
      providerId: env.provider.id, dbSourceId: env.dbSource.id, webSearch: false, knowledgeSearchEnabled: true }), signal: AbortSignal.timeout(180000) });
    const result = await response.json();
    if (!result.execution && result.answerEnvelope?.executionRef?.runId) {
      const state = await (await fetch(base + '/api/automation-runs/' + encodeURIComponent(result.answerEnvelope.executionRef.runId), { headers })).json();
      result.execution = state.execution;
    }
    if (result.execution?.id) runs.add(result.execution.id);
    const record = { id, question, sessionId, result }; records.push(record); save();
    console.log(JSON.stringify({ id, status: result.execution?.status, templateId: result.execution?.templateId,
      missing: result.execution?.missingInputs?.map(item => item.key), tools: result.toolCalls?.map(item => item.name), reply: result.reply }));
    return record;
  };
  const wait = async record => {
    const runId = record.result.execution?.id; if (!runId) return;
    for (let i = 0; i < 40; i++) {
      const response = await fetch(base + '/api/automation-runs/' + encodeURIComponent(runId), { headers });
      const value = await response.json(); record.execution = value.execution; save();
      if (['SUCCEEDED','FAILED','CANCELLED','WAITING_INPUT'].includes(value.execution?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(JSON.stringify({ id: record.id, final: record.execution?.status, chart: record.execution?.result?.chart, error: record.execution?.error }));
  };
  try {
    const missing = await ask('missing_export', 'vẽ biểu đồ sản lượng điện bán ra trong 7 tháng', prefix);
    await wait(missing);
    const continued = await ask('answer_export', 'không xuất file', prefix);
    await wait(continued);
    const complete = await ask('all_inputs', 'vẽ biểu đồ sản lượng điện bán ra trong 7 tháng, không xuất file Excel', prefix + '-complete');
    await wait(complete);
    const assert = require('node:assert/strict');
    for (const record of records) {
      assert.equal(record.result.execution?.templateId, 'electricity_sales/last_seven_months');
      assert.ok(!record.result.toolCalls?.some(item => item.name === 'execute_sql_query'), 'Manual SQL bypassed workflow');
    }
    assert.equal(missing.execution?.status, 'WAITING_INPUT');
    assert.deepEqual(missing.execution?.missingInputs?.map(item => item.key), ['exportFile']);
    assert.equal(continued.result.execution?.id, missing.result.execution?.id, 'Follow-up created a new run');
    for (const record of [continued, complete]) {
      assert.equal(record.execution?.status, 'SUCCEEDED');
      assert.ok(record.execution?.result?.chart?.points?.length > 0, 'Workflow chart missing');
    }
    console.log('PASS: workflow priority, missing inputs, same-run continuation and real chart output');
    const ids = new Set(records.map(record => record.result.auditId));
    const history = await (await fetch(base + '/api/chat-history', { headers })).json();
    fs.writeFileSync('artifacts/semantic-model/workflow-priority-audits.json', JSON.stringify(history.filter(item => ids.has(item.id))
      .map(item => ({ id: item.id, diagnostics: item.requestPayload?.diagnostics })), null, 2));
  } finally {
    for (const id of runs) {
      const value = await (await fetch(base + '/api/automation-runs/' + encodeURIComponent(id), { headers })).json();
      const run = value.execution;
      if (run?.conversationId?.startsWith(prefix) && ['WAITING_INPUT','READY'].includes(run.status))
        await fetch(base + '/api/automation-runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers, body: JSON.stringify({ revision: run.revision }) });
    }
    await fetch(base + '/api/auth/logout', { method: 'POST', headers });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
