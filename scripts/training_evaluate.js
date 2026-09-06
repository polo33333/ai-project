'use strict';

const path = require('path');
const { collectCases } = require('../src/backend/training_core/case_collector');
const { evaluateCases } = require('../src/backend/training_core/regression_runner');

const root = path.join(__dirname, '..');
const report = evaluateCases(collectCases({
  historyFile: path.join(root, 'data', 'chat_history.json'),
  feedbackFile: path.join(root, 'data', 'chat_feedback.json'),
  reviewStatus: 'needs_review'
}));
console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, failureCounts: report.failureCounts }, null, 2));
process.exitCode = report.failed ? 1 : 0;
