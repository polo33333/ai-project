'use strict';

const { classifyCase } = require('./failure_classifier');

function evaluateCases(cases = []) {
  const results = cases.map(item => ({ id: item.id, rating: item.rating, failures: classifyCase(item) }));
  const failureCounts = results.flatMap(item => item.failures).reduce((counts, failure) => {
    counts[failure] = (counts[failure] || 0) + 1;
    return counts;
  }, {});
  return {
    total: results.length,
    passed: results.filter(item => item.failures.length === 0).length,
    failed: results.filter(item => item.failures.length > 0).length,
    failureCounts,
    results
  };
}

module.exports = { evaluateCases };
