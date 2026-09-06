const crypto = require('crypto');
const StorageHelper = require('../../utils/storage_helper');
const WorkflowEngine = require('./workflow_engine');
const { createStep } = require('./automation_steps');

class WorkflowService {
  constructor() {
    this.workflows = StorageHelper.loadJson('workflows.json', [createDefaultDataExportWorkflow()]);
    this.runs = StorageHelper.loadJson('workflow_runs.json', []);
  }

  persist() {
    StorageHelper.saveJson('workflows.json', this.workflows);
    StorageHelper.saveJson('workflow_runs.json', this.runs);
  }

  list() { return this.workflows.map(item => ({ ...item, webhookSecret: item.webhookSecret ? '***' : null })); }
  get(id) { return this.workflows.find(item => item.id === id) || null; }
  history(workflowId = null) { return this.runs.filter(run => !workflowId || run.workflowId === workflowId).slice(0, 100); }

  save(definition) {
    if (!definition?.name) throw new Error('Workflow name is required');
    if (!Array.isArray(definition.steps) || definition.steps.length === 0) throw new Error('Workflow requires at least one step');
    definition.steps.forEach(createStep);
    const now = new Date().toISOString();
    const existingIndex = definition.id ? this.workflows.findIndex(item => item.id === definition.id) : -1;
    const previous = existingIndex >= 0 ? this.workflows[existingIndex] : null;
    const workflow = {
      ...previous,
      ...definition,
      id: definition.id || `wf_${crypto.randomUUID()}`,
      enabled: definition.enabled !== false,
      trigger: definition.trigger || { type: 'manual' },
      webhookSecret: definition.webhookSecret && definition.webhookSecret !== '***'
        ? definition.webhookSecret
        : (previous?.webhookSecret || crypto.randomBytes(24).toString('hex')),
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
    if (existingIndex >= 0) this.workflows[existingIndex] = workflow;
    else this.workflows.unshift(workflow);
    this.persist();
    return workflow;
  }

  remove(id) {
    const count = this.workflows.length;
    this.workflows = this.workflows.filter(item => item.id !== id);
    if (this.workflows.length === count) return false;
    this.persist();
    return true;
  }

  async run(id, input = {}, context = {}) {
    const definition = this.get(id);
    if (!definition) throw new Error(`Workflow "${id}" not found`);
    if (!definition.enabled) throw new Error(`Workflow "${id}" is disabled`);
    const engine = new WorkflowEngine(definition);
    for (const stepDefinition of definition.steps) {
      const step = createStep(stepDefinition);
      const runWhen = stepDefinition.runWhen;
      engine.addStep(step, runWhen ? state => Boolean(resolvePath(state, runWhen)) : null);
    }
    const runId = `run_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const execution = await engine.run({ input, ...input }, context);
    const record = { runId, workflowId: id, triggerType: context.triggerType || 'manual', startedAt, finishedAt: new Date().toISOString(), ...execution };
    this.runs.unshift(record);
    if (this.runs.length > 500) this.runs.length = 500;
    this.persist();
    return record;
  }

  async runWebhook(id, secret, input) {
    const workflow = this.get(id);
    if (!workflow || workflow.trigger?.type !== 'webhook') throw new Error('Webhook workflow not found');
    if (!secret || secret !== workflow.webhookSecret) throw new Error('Invalid webhook secret');
    return this.run(id, input, { triggerType: 'webhook', permissions: workflow.permissions || [] });
  }
}

function resolvePath(state, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], state);
}

module.exports = new WorkflowService();

function createDefaultDataExportWorkflow() {
  const now = new Date().toISOString();
  return {
    id: 'data_export_pipeline',
    name: 'Data Export Pipeline',
    description: 'Run a safe SELECT query and export returned rows.',
    enabled: true,
    trigger: { type: 'manual' },
    permissions: ['sql:read'],
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    steps: [
      { id: 'query', name: 'Execute SQL', type: 'sql', config: { sql: '{{input.sql}}', outputKey: 'query' } },
      { id: 'export', name: 'Export data', type: 'export', runWhen: 'query.rowCount', config: {
        data: '{{query.rows}}', format: '{{input.exportFormat}}', filename: '{{input.exportFilename}}', outputKey: 'export'
      } }
    ],
    createdAt: now,
    updatedAt: now
  };
}
