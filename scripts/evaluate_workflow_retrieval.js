'use strict';
// Read-only retrieval evaluation: no workflow, SQL business query, or index writes.
const fs = require('node:fs');
const path = require('node:path');
require('../src/backend/storage/postgres/config').loadEnvironment();
const { WorkflowRetrieval } = require('../src/backend/automation/workflow_retrieval');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
async function main() {
  const artifact = name => path.resolve(__dirname, '../artifacts', name);
  const corpus = JSON.parse(fs.readFileSync(artifact('history-routing-corpus.private.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(artifact('history-routing-labels.private.json'), 'utf8')).labels;
  const cases = corpus.cases.map(item => ({ ...item, expected: labels.find(label => label.question === item.question) }));
  if (cases.some(item => !item.expected)) throw new Error('Missing reviewed labels');
  const report = { createdAt: new Date().toISOString(), scope: 'retrieval only, historical authorized catalog; no TEV1 or workflow execution', catalogCount: corpus.definitions.length, summaries: [], results: [] };
  const methods = process.argv.includes('--lexical-only') ? ['lexical'] : ['lexical', 'hybrid'];
  for (const method of methods) {
    process.env.CHAT_ROUTING_RETRIEVAL_METHOD = method;
    const service = new WorkflowRetrieval();
    for (const k of [5, 8, 10, 12, 15]) {
      process.env.CHAT_ROUTING_RETRIEVAL_TOP_K = String(k);
      const results = [];
      for (const item of cases) {
        const started = Date.now();
        let row = { id: item.id, method, k, expectedWorkflowId: item.expected.workflowId || null };
        try {
          const result = await service.search(item.question, corpus.definitions, null, {
            routingMode: 'auto', executionBudget: new RequestExecutionBudget({ maxModelCalls: 12 }), history: item.history
          });
          row = { ...row, candidateIds: result.trace.candidateIds, found: item.expected.workflowId ? result.trace.candidateIds.includes(item.expected.workflowId) : null,
            evaluations: result.trace.evaluations, taskTokens: result.trace.taskTokens };
        } catch (error) { row.errorCode = error.code || error.name; row.found = item.expected.workflowId ? false : null; }
        row.wallMs = Date.now() - started; results.push(row);
      }
      const business = results.filter(item => item.expectedWorkflowId);
      const times = results.map(item => item.wallMs).sort((a, b) => a - b);
      const summary = { method, k, turns: results.length, workflowTurns: business.length, found: business.filter(item => item.found).length,
        fallback: results.filter(item => item.errorCode).length, p95Ms: times[Math.ceil(times.length * 0.95) - 1] || 0 };
      report.summaries.push(summary); report.results.push(...results); console.log(JSON.stringify(summary));
    }
  }
  const output = artifact(`workflow-retrieval-evaluation-${Date.now()}.private.json`);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: output }));
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
