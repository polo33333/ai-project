'use strict';

const policy = require('./memory_policy');

function detectTopic({ currentPlan = {}, lastPlan = null, questionText = '', references = {}, now = Date.now() } = {}) {
  if (!lastPlan) return { mode: 'none', reason: 'no_prior_context' };

  const tableChanged = Boolean(currentPlan.table && lastPlan.table && currentPlan.table !== lastPlan.table);
  const domainChanged = policy.getDomain(currentPlan.table) !== policy.getDomain(lastPlan.table);
  const hasPronoun = policy.hasReferencePronoun(questionText);
  const selfContained = policy.isPlanSelfContained(currentPlan);

  if (selfContained && !hasPronoun && tableChanged) {
    return { mode: 'none', reason: 'topic_changed', confidence: 'high' };
  }
  if (hasPronoun && policy.isExportOrChartIntent(questionText)) {
    return { mode: 'reference', reason: 'reference_pronoun_detected' };
  }
  if (!tableChanged && currentPlan.table && lastPlan.table) {
    return { mode: 'recent', reason: 'same_table_followup', maxMessages: policy.recentMaxMessages() };
  }
  if (!selfContained && policy.isShortContextualFollowup(questionText)) {
    return { mode: 'recent', reason: 'short_contextual_followup', maxMessages: policy.recentMaxMessages() };
  }
  if (tableChanged && hasPronoun) {
    if (domainChanged) {
      const hasEntity = Boolean(references.lastEntity?.updatedAt);
      return hasEntity
        ? { mode: 'reference', reason: 'cross_domain_entity_reference' }
        : { mode: 'none', reason: 'topic_changed_ambiguous_pronoun', confidence: 'medium' };
    }
    return { mode: 'recent', reason: 'related_table_followup', maxMessages: Math.min(2, policy.recentMaxMessages()) };
  }
  if (hasPronoun) return { mode: 'reference', reason: 'reference_pronoun_detected' };
  return { mode: 'none', reason: 'independent_request', confidence: selfContained ? 'high' : 'low' };
}

module.exports = { detectTopic };
