'use strict';

const path = require('path');
const { collectCases } = require('../src/backend/training_core/case_collector');
const { evaluateCases } = require('../src/backend/training_core/regression_runner');
const storage = require('../src/backend/storage');
storage.loadEnvironment();

const root = path.join(__dirname, '..');
async function main() {
await storage.bootstrapStorage();
try { await storage.run(() => {
const report = evaluateCases(collectCases({
  historyFile: path.join(root, 'data', 'chat_history.json'),
  feedbackFile: path.join(root, 'data', 'chat_feedback.json'),
  reviewStatus: 'needs_review'
}));
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, failureCounts: report.failureCounts }, null, 2));
process.exitCode = report.failed ? 1 : 0;
}); } finally { await storage.close(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });
