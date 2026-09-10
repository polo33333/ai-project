'use strict';

const { getSkills, getSkill } = require('./registry');
const { selectSkill } = require('./selector');
const { selectExamples } = require('./examples');

module.exports = { getSkills, getSkill, selectSkill, selectExamples };
