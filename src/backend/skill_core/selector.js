'use strict';

const { getSkills } = require('./registry');
const { inspectSkill } = require('./skill_contract');

function selectSkill({ requestPlan = {}, question = '' } = {}) {
  const skill = getSkills().find(item => item.intents.includes(requestPlan.intent));
  if (!skill) return { matched: false, status: 'no_match', skill: null, missingInputs: [], reason: `unsupported_intent:${requestPlan.intent || 'none'}` };
  const inspection = inspectSkill(skill, requestPlan);
  return inspection.status === 'matched'
    ? { matched: true, ...inspection, skill, question }
    : { matched: false, ...inspection, skill: null, candidateSkillId: skill.id, question };
}

module.exports = { selectSkill };
