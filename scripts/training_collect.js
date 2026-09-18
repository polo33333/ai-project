'use strict';

const fs = require('fs');
const path = require('path');
const { collectCases } = require('../src/backend/training_core/case_collector');
const { classifyCase } = require('../src/backend/training_core/failure_classifier');
const storage = require('../src/backend/storage');
storage.loadEnvironment();

const root = path.join(__dirname, '..');
const outputDir = path.join(root, 'data', 'training');
async function main() {
await storage.bootstrapStorage();
try { await storage.run(() => {
const cases = collectCases({
  historyFile: path.join(root, 'data', 'chat_history.json'),
  feedbackFile: path.join(root, 'data', 'chat_feedback.json'),
  reviewStatus: 'needs_review'
}).map(item => {
  const detectedFailures = classifyCase(item);
  return { ...item, failures: detectedFailures.length ? detectedFailures : ['REVIEW_REQUESTED'] };
});
if (storage.enabled()) require('../src/backend/utils/storage_helper').saveJson('training/regression_cases.json', cases);
else {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'regression_cases.json'), JSON.stringify(cases, null, 2), 'utf8');
}
console.log(`Collected ${cases.length} training cases; storage=${process.env.APP_STORAGE_BACKEND || 'json'}`);
}); } finally { await storage.close(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });
