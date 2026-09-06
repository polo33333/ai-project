'use strict';

const path = require('path');
const { collectCases } = require('./case_collector');
const { classifyCase } = require('./failure_classifier');
const { suggestForCase } = require('./suggestion_engine');

function buildTrainingReport(rootDir = path.join(__dirname, '../../..')) {
  const cases = collectCases({
    historyFile: path.join(rootDir, 'data', 'chat_history.json'),
    feedbackFile: path.join(rootDir, 'data', 'chat_feedback.json'),
    reviewStatus: 'needs_review'
  }).map(item => {
    const detectedFailures = classifyCase(item);
    const failures = detectedFailures.length ? detectedFailures : ['REVIEW_REQUESTED'];
    return { ...item, failures, suggestions: suggestForCase({ ...item, failures }) };
  });
  const failureCounts = cases.flatMap(item => item.failures).reduce((result, failure) => {
    result[failure] = (result[failure] || 0) + 1;
    return result;
  }, {});
  const failed = cases.filter(item => item.failures.length > 0).length;
  return {
    generatedAt: new Date().toISOString(),
    scope: { reviewStatus: 'needs_review' },
    summary: { total: cases.length, passed: cases.length - failed, failed, disliked: cases.filter(item => item.rating === 'dislike').length },
    failureCounts,
    cases
  };
}

module.exports = { buildTrainingReport };
