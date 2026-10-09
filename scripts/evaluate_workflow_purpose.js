'use strict';
// Routing and metadata explanations only. Never create/execute a workflow or business SQL.
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') throw new Error('Preload isolated test data');
const fs = require('node:fs');
const path = require('node:path');
require('../src/backend/storage/postgres/config').loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const router = require('../src/backend/automation/chat_router');
async function main() {
  const root = path.resolve(__dirname, '../artifacts');
  const corpus = JSON.parse(fs.readFileSync(path.join(root, 'history-routing-corpus.private.json')));
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'history-routing-labels.private.json'))).labels;
  const pool = createPool({ runtime: true }); let provider;
  try { provider = (await new PostgresRepository(pool).snapshot(['ai_providers.json'])).documents.get('ai_providers.json').find(item => item.isActive); }
  finally { await pool.end(); }
  if (!provider) throw new Error('No active chat provider');
  const cases = corpus.definitions.flatMap(d => [
    { question: `Nghiệp vụ “${d.name}” hỗ trợ những tùy chọn nào?`, purpose: 'explain', workflowId: d.id },
    { question: `Chỉ giải thích cách dùng nghiệp vụ “${d.name}”, không thực hiện.`, purpose: 'explain', workflowId: d.id },
    { question: `Hãy thực hiện nghiệp vụ “${d.name}” giúp tôi.`, purpose: 'execute', workflowId: d.id }
  ]);
  for (const item of corpus.cases.filter(item => labels.find(label => label.question === item.question)?.category === 'capability_question')) {
    cases.push({ question: item.question, history: item.history, purpose: 'explain' });
  }
  process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'hybrid';
  const report = { createdAt: new Date().toISOString(), scope: 'purpose routing and metadata explanation only; no run/SQL execution', results: [] };
  const output = path.join(root, `workflow-purpose-evaluation-${Date.now()}.private.json`);
  for (const mode of ['auto', 'chat_model']) {
    process.env.CHAT_ROUTING_MODE = mode;
    for (const item of cases) {
      const context = router.createRoutingContext({ chatProviderSnapshot: provider });
      const row = { mode, expected: item, passed: false };
      try {
        row.decision = await router.decide(item.question, corpus.definitions, null, { routingContext: context, history: item.history });
        row.passed = row.decision.purpose === item.purpose && (!item.workflowId || row.decision.workflowId === item.workflowId)
          && row.decision.route === (item.purpose === 'explain' ? 'chat' : 'workflow');
        if (row.passed && item.purpose === 'explain') {
          const d = corpus.definitions.find(d => d.id === row.decision.workflowId);
          row.reply = (await require('../src/backend/automation/workflow_explanation').explain(item.question, d, { routingContext: context })).replyText;
        }
      } catch (error) { row.errorCode = error.code || error.name; row.passed = false; }
      row.trace = context.trace; report.results.push(row);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, purpose: item.purpose, passed: row.passed, actualPurpose: row.decision?.purpose, errorCode: row.errorCode }));
    }
  }
  report.summary = Object.fromEntries(['auto', 'chat_model'].map(mode => {
    const rows = report.results.filter(r => r.mode === mode); return [mode, { passed: rows.filter(r => r.passed).length, total: rows.length }];
  }));
  fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ summary: report.summary, report: output }));
}
main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
