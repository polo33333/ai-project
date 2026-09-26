'use strict';
const { AutomationRepository } = require('./repository');
const { PluginRegistry, requireAdmin } = require('./registry');
const { AutomationRuntime } = require('./runtime');
const { error } = require('./contract');
const repository = new AutomationRepository(), registry = new PluginRegistry(repository);
let enabled = process.env.WORKFLOW_PLUGINS_ENABLED === 'true';
const disabledByEnvironment = () => process.env.WORKFLOW_PLUGINS_ENABLED?.trim().toLowerCase() === 'false';
async function settings() {
  let stored;
  try { stored = await repository.get('catalog', '_settings'); }
  catch (failure) {
    if (failure.code !== '42P01') throw failure;
    enabled = false; return { enabled: false, revision: null, migrationRequired: true, phase: 1, contractVersion: 1 };
  }
  enabled = !disabledByEnvironment() && (stored ? stored.enabled === true : process.env.WORKFLOW_PLUGINS_ENABLED === 'true');
  return { enabled, disabledByEnvironment: disabledByEnvironment(), revision: stored?.revision || null, contractVersion: 1, phase: 1 };
}
async function configure(value, context) {
  requireAdmin(context);
  if (typeof value.enabled !== 'boolean') throw error('enabled phải là boolean.');
  if (value.enabled && disabledByEnvironment()) throw error('Workflow/plugin bị tắt bởi WORKFLOW_PLUGINS_ENABLED=false trong cấu hình máy chủ.', 409);
  const previous = await repository.get('catalog', '_settings');
  if ((previous?.revision || null) !== (value.revision || null)) throw error('Cấu hình đã thay đổi.', 409);
  const saved = await repository.put('catalog', { id: '_settings', enabled: value.enabled }, previous?.revision ?? null);
  enabled = saved.enabled; return settings();
}
const runtime = new AutomationRuntime(repository, registry, { enabled: () => enabled && !disabledByEnvironment() });
const originalTick = runtime.tick.bind(runtime);
runtime.tick = async () => { await settings(); return originalTick(); };
async function starter(context) {
  requireAdmin(context);
  const pilot = structuredClone(require('./pilot.json'));
  const skills = require('../skill_core').getSkills();
  pilot.legacySkills = structuredClone(skills);
  for (const [index, skill] of skills.entries()) {
    if (pilot.templates[index]) {
      pilot.templates[index].instructions = skill.instructions;
      pilot.templates[index].enabled = skill.enabled;
      pilot.templates[index].legacySkillRef = { id: skill.id, version: skill.version, exampleIds: skill.exampleIds };
    }
  }
  return pilot;
}
module.exports = { repository, registry, runtime, settings, configure, starter };
