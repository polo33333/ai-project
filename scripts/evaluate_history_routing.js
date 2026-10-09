'use strict';
// Replay routing only, with owned historical context. Never call IntelligentCore/runtime.
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') throw new Error('Preload tests/helpers/setup_isolated_data.js');
const fs = require('node:fs');
const path = require('node:path');
require('../src/backend/storage/postgres/config').loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const router = require('../src/backend/automation/chat_router');
const { hash } = require('../src/backend/automation/contract');
const requestedMethod = process.argv.includes('--lexical') ? 'lexical' : process.argv.includes('--hybrid') ? 'hybrid' : null;
const runTag = requestedMethod ? `${requestedMethod}-${Date.now()}` : null;
const artifact = name => path.resolve(__dirname, '../artifacts', runTag && name === 'history-routing-evaluation.private.json' ? `history-routing-evaluation-${runTag}.private.json` : name);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] || 0;
async function main() {
  if (requestedMethod) process.env.CHAT_ROUTING_RETRIEVAL_METHOD = requestedMethod;
  const corpus = JSON.parse(fs.readFileSync(artifact('history-routing-corpus.private.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(artifact('history-routing-labels.private.json'), 'utf8')).labels;
  const labeled = corpus.cases.map(item => ({ ...item, expected: labels.find(label => label.question === item.question) }));
  if (labeled.some(item => !item.expected)) throw new Error('Every historical question needs a reviewed label');
  const pool = createPool({ runtime: true });
  let provider;
  try {
    const snapshot = await new PostgresRepository(pool).snapshot(['ai_providers.json']);
    provider = snapshot.documents.get('ai_providers.json').find(item => item.isActive);
  } finally { await pool.end(); }
  if (!provider) throw new Error('No active chat provider');
  process.env.CHAT_ROUTING_MODE = 'auto';
  const report = { date: new Date().toISOString(), retrievalMethod: process.env.CHAT_ROUTING_RETRIEVAL_METHOD || 'hybrid', scope: 'router.decide only; not full chat/data correctness',
    sourceTurns: corpus.cases.length, uniqueQuestions: new Set(corpus.cases.map(item => item.question)).size,
    catalogCount: corpus.definitions.length, labelMethod: 'Reviewed independently from user intent/current catalog',
    contextLimitations: 'Saved UI messages and owner-checked completed workflow metadata; historical pending transitions/form actions not replayed; no result rows included',
    chatModel: provider.model, results: [], summaries: {} };
  const modes = process.argv.includes('--retrieval-only') ? ['on'] : ['off', 'on'];
  for (const mode of modes) {
    process.env.CHAT_ROUTING_RETRIEVAL_MODE = mode;
    for (const item of labeled) {
      const started = Date.now();
      const context = router.createRoutingContext({ chatProviderSnapshot: provider });
      const options = { routingContext: context, history: item.history, workflowMemory: item.workflowMemory };
      let recall = null;
      try {
        const decision = await router.decide(item.question, corpus.definitions, null, options);
        if (mode === 'on' && item.expected.workflowId && context.trace.retrieval?.status === 'ok') {
          recall = { found: context.trace.retrieval.candidateIds.includes(item.expected.workflowId),
            candidates: context.trace.retrieval.candidateIds, candidateCount: context.trace.retrieval.candidateCount };
        }
        const routePassed = decision.route === item.expected.route && decision.workflowId === (item.expected.workflowId || null);
        const inputsPassed = hash(decision.inputs) === hash(item.expected.inputs || {});
        report.results.push({ id: item.id, mode, question: item.question, category: item.expected.category, expected: item.expected,
          historicalRoute: item.historicalRouting?.route || null, historicalWorkflowId: item.historicalRouting?.workflowId || null,
          routePassed, inputsPassed, passed: routePassed && inputsPassed, decision, recall,
          routingMs: context.trace.latencyMs || context.trace.stages.reduce((sum, stage) => sum + (stage.latencyMs || 0), 0),
          wallMs: Date.now() - started, trace: context.trace });
      } catch (error) {
        report.results.push({ id: item.id, mode, question: item.question, category: item.expected.category, expected: item.expected,
          passed: false, errorCode: error.code, error: error.message, recall, wallMs: Date.now() - started, trace: context.trace });
      }
      const result = report.results.at(-1);
      fs.writeFileSync(artifact('history-routing-evaluation.private.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, id: item.id, passed: result.passed, source: result.trace.decisionSource,
        route: result.decision?.route, wallMs: result.wallMs, errorCode: result.errorCode }));
    }
    const results = report.results.filter(item => item.mode === mode);
    const workflow = results.filter(item => item.expected.workflowId);
    const recalls = results.filter(item => item.recall);
    const categories = Object.fromEntries([...new Set(results.map(item => item.category))].map(category => {
      const group = results.filter(item => item.category === category);
      return [category, { passed: group.filter(item => item.passed).length, total: group.length }];
    }));
    report.summaries[mode] = { passed: results.filter(item => item.passed).length, total: results.length,
      routePassed: results.filter(item => item.routePassed).length, workflowTotal: workflow.length,
      directTev1: results.filter(item => item.trace.decisionSource === 'local_tev1').length,
      escalated: results.filter(item => item.trace.escalated).length, recallFound: recalls.filter(item => item.recall.found).length,
      recallMeasured: recalls.length, p50WallMs: percentile(results.map(item => item.wallMs), 0.5),
      p95WallMs: percentile(results.map(item => item.wallMs), 0.95), categories };
    fs.writeFileSync(artifact('history-routing-evaluation.private.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ mode, summary: report.summaries[mode] }));
  }
  console.log(JSON.stringify({ summaries: report.summaries, report: artifact('history-routing-evaluation.private.json') }));
  if (!runTag) require('./report_history_routing_eval');
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
