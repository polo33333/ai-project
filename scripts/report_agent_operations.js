'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvironment } = require('../src/backend/storage/postgres/config');
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const { summarize, feedbackCases } = require('../src/backend/governance/operations');
async function main() {
  loadEnvironment();
  const policy = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : {};
  const pool = createPool({ runtime: true });
  try {
    const { documents } = await new PostgresRepository(pool).snapshot(['chat_history.json', 'chat_feedback.json']);
    const audits = documents.get('chat_history.json') || [], feedback = documents.get('chat_feedback.json') || [];
    const report = summarize(audits, policy), regressions = feedbackCases(feedback, audits);
    const output = path.resolve('artifacts/agent-acceptance'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'operations.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(output, 'feedback-regressions.private.json'), `${JSON.stringify(regressions, null, 2)}\n`);
    console.log(JSON.stringify({ requests: report.requests, statuses: report.statuses, latency: report.latency,
      alerts: report.alerts, feedbackCases: regressions.cases.length, feedbackSkipped: regressions.skipped.length }, null, 2));
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || 'OPERATIONS_REPORT_FAILED'); process.exitCode = 1; });
