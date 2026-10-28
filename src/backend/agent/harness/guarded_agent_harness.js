'use strict';

// GuardedAgentHarness runs one request through named steps (./steps):
// prepare -> contract pipeline (v2) -> direct list -> memory resolution ->
// agent loop -> outputs -> finalize. Each step reads and updates the shared
// request state built by prepare.
const { createProviderBudget, boundedCall, wireMessages } = require('./steps/common');
const { prepare } = require('./steps/prepare');
const { createDispatch } = require('./steps/dispatch');
const { installWorkflowAssessment } = require('./steps/workflow_assessment');
const { runContractStage } = require('./steps/contract_stage');
const { runDirectList } = require('./steps/direct_list');
const { resolveConversationMemory } = require('./steps/memory_resolution');
const { runAgentLoop } = require('./steps/agent_loop');
const { completeOutputs } = require('./steps/outputs');
const { finalizeAnswer } = require('./steps/finalize');

class GuardedAgentHarness {
  constructor({ toolManager, maxIterations = 10, dispatch, maxRepairs } = {}) {
    this.toolManager = toolManager;
    this.maxIterations = maxIterations;
    this.dispatch = dispatch;
    this.maxRepairs = Math.max(0, Number(maxRepairs ?? process.env.AI_PROVIDER_MAX_REPAIRS ?? 2) || 0);
  }

  async run(input = {}) {
    const s = await prepare(this, input);
    s.dispatch = createDispatch(s);
    installWorkflowAssessment(s);
    const contracted = await runContractStage(s);
    if (contracted) return contracted;
    await runDirectList(s);
    await resolveConversationMemory(s);
    const handedOff = await runAgentLoop(s);
    if (handedOff) return handedOff;
    await completeOutputs(s);
    return finalizeAnswer(s);
  }
}

module.exports = GuardedAgentHarness;
module.exports.createProviderBudget = createProviderBudget;
module.exports.boundedCall = boundedCall;
module.exports.wireMessages = wireMessages;
