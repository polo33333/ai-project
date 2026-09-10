'use strict';

const { getSkills } = require('./registry');

function selectSkill({ requestPlan = {}, question = '' } = {}) {
  if (!requestPlan.table || requestPlan.outputs?.data === false) return { matched: false, skill: null, reason: 'no_data_plan' };
  const skill = getSkills().find(item => item.intents.includes(requestPlan.intent));
  return skill
    ? { matched: true, skill, reason: `intent:${requestPlan.intent}`, question }
    : { matched: false, skill: null, reason: `unsupported_intent:${requestPlan.intent || 'none'}` };
}

module.exports = { selectSkill };
