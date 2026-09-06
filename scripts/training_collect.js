'use strict';

const fs = require('fs');
const path = require('path');
const { collectCases } = require('../src/backend/training_core/case_collector');
const { classifyCase } = require('../src/backend/training_core/failure_classifier');

const root = path.join(__dirname, '..');
const outputDir = path.join(root, 'data', 'training');
const cases = collectCases({
  historyFile: path.join(root, 'data', 'chat_history.json'),
  feedbackFile: path.join(root, 'data', 'chat_feedback.json'),
  reviewStatus: 'needs_review'
}).map(item => {
  const detectedFailures = classifyCase(item);
  return { ...item, failures: detectedFailures.length ? detectedFailures : ['REVIEW_REQUESTED'] };
});
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'regression_cases.json'), JSON.stringify(cases, null, 2), 'utf8');
console.log(`Collected ${cases.length} training cases in data/training/regression_cases.json`);
