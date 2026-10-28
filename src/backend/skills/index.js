'use strict';

const { getSkills, getSkill, saveSkill } = require('./registry');
const { selectSkill } = require('./selector');
const { getExampleCatalog, selectExamples } = require('./examples');

module.exports = { getSkills, getSkill, saveSkill, selectSkill, selectExamples, getExampleCatalog };
