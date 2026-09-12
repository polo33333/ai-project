'use strict';

const policy = require('./memory_policy');
const { detectTopic } = require('./topic_detector');
const { resolveReference } = require('./reference_store');

function routeMemory({ currentPlan, session, question, fallbackHistory = [], now = Date.now() } = {}) {
  if (!policy.isEnabled()) {
    return { mode: 'recent', reason: 'memory_core_disabled', maxMessages: 10, fallbackHistory };
  }
  try {
    const base = detectTopic({ currentPlan, lastPlan: session?.lastPlan, questionText: question, references: session?.references, now });
    const decision = {
      ...base,
      previousScope: session?.activeScope || policy.getDomain(session?.lastPlan?.table),
      currentScope: policy.getDomain(currentPlan?.table),
      confidence: base.confidence || 'medium',
      sessionId: session?.id || null,
      fallbackHistory
    };
    if (base.mode === 'reference') {
      const resolvedReference = resolveReference(question, session?.references || {}, now);
      if (!resolvedReference.type) return { ...decision, mode: 'none', reason: resolvedReference.reason };
      decision.reference = resolvedReference;
    }
    if (policy.isShadowMode()) {
      return { ...decision, shadowDecision: { ...decision, fallbackHistory: undefined }, mode: 'recent', reason: 'shadow_mode', maxMessages: 10 };
    }
    return decision;
  } catch (error) {
    return { mode: 'none', reason: 'memory_core_error', error: error.message, fallbackHistory };
  }
}

module.exports = { routeMemory };
