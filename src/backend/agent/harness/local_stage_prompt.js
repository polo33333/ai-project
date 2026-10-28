'use strict';

// What a local (Ollama) provider gets on top of the shared stage prompt.
// dispatch calls these only for local candidates; remote providers keep the
// shared prompt unchanged.
const { buildLocalMessages } = require('./local_prompt_builder');

const STRUCTURED_STAGES = new Set(['v2_contract', 'v2_contract_repair']);

// Business skill and reviewed examples for the request plan.
function selectGuidance(plan = {}, question = '') {
  const enabled = process.env.LOCAL_MODEL_SKILL_CORE_ENABLED === 'true';
  const fewShotEnabled = enabled && process.env.LOCAL_MODEL_FEW_SHOT_ENABLED === 'true';
  const skillCore = require('../../skills');
  const selection = enabled ? skillCore.selectSkill({ requestPlan: plan, question }) : { matched: false, skill: null, reason: 'disabled' };
  const examples = fewShotEnabled && selection.matched ? skillCore.selectExamples(selection.skill, plan) : [];
  return { skill: selection.skill, examples, trace: {
    enabled, fewShotEnabled, matched: selection.matched,
    status: enabled ? (selection.status || (selection.matched ? 'matched' : 'no_match')) : 'disabled',
    skillId: selection.skill?.id || selection.candidateSkillId || null,
    skillVersion: selection.skill?.version || null,
    reason: selection.reason, missingInputs: selection.missingInputs || [],
    exampleCount: examples.length, injected: false
  } };
}

// Agent loop: tool protocol, request policy, skill and examples in the
// leading system message.
function agentMessages(messages, definitions, policy, guidance) {
  return buildLocalMessages(messages, definitions, policy, { skill: guidance.skill, examples: guidance.examples });
}

// A single-tool planning stage answered as JSON constrained by the tool's
// schema (Ollama `format`) instead of a native tool call, which small models
// often leave incomplete. The stage decoder already reads JSON content.
function structuredRequest(candidate, messages, definitions, stage) {
  if (process.env.LOCAL_MODEL_STRUCTURED_CONTRACT === 'false' || !STRUCTURED_STAGES.has(stage) || definitions.length !== 1) return null;
  const fn = definitions[0].function || definitions[0];
  if (!fn?.parameters) return null;
  const instruction = `Return only the ${fn.name} arguments as one JSON object matching this JSON schema, with no tool call and no prose:\n${JSON.stringify(fn.parameters)}`;
  return {
    provider: { ...candidate, responseFormat: fn.parameters },
    messages: messages[0]?.role === 'system'
      ? messages.map((message, index) => index ? message : { ...message, content: `${message.content}\n${instruction}` })
      : [{ role: 'system', content: instruction }, ...messages]
  };
}

module.exports = { selectGuidance, agentMessages, structuredRequest };
