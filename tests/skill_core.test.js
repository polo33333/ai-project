'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const skillCore = require('../src/backend/skill_core');
const { buildLocalMessages } = require('../src/backend/agent_core/harness/local_prompt_builder');

const reportPlan = {
  intent: 'aggregate_timeseries', table: 'Electricity', metric: 'TotalQty', timeColumn: 'ReadingDate',
  aggregation: 'SUM', schemaColumns: ['ReadingDate', 'TotalQty'], outputs: { data: true }
};

test('skill selector routes lookup and aggregate plans and fails closed without a table', () => {
  assert.equal(skillCore.selectSkill({ requestPlan: { intent: 'record_lookup', table: 'Customer', outputs: { data: true } } }).skill.id, 'record_lookup');
  assert.equal(skillCore.selectSkill({ requestPlan: reportPlan }).skill.id, 'aggregate_report');
  assert.equal(skillCore.selectSkill({ requestPlan: { intent: 'record_lookup' } }).matched, false);
});

test('few-shot selector renders only examples compatible with the selected schema', () => {
  const selected = skillCore.selectSkill({ requestPlan: reportPlan });
  const examples = skillCore.selectExamples(selected.skill, reportPlan);
  assert.equal(examples.length, 2);
  assert.match(examples[0], /Electricity/);
  assert.match(examples[0], /TotalQty/);
  assert.doesNotMatch(examples.join('\n'), /Customer/);
});

test('prompt includes skill and examples only when guidance is supplied', () => {
  const base = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Report' }];
  const definitions = [{ function: { name: 'execute_sql_query', parameters: { required: ['sql'] } } }];
  const plain = buildLocalMessages(base, definitions, {}, {});
  const guided = buildLocalMessages(base, definitions, {}, { skill: { id: 'aggregate_report', version: 1, instructions: 'Use aggregate.' }, examples: ['Example SQL'] });
  assert.doesNotMatch(plain[0].content, /Business skill/);
  assert.match(guided[0].content, /aggregate_report@1/);
  assert.match(guided[0].content, /Example SQL/);
});
