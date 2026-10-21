'use strict';

const { sanitizeObject } = require('../memory_core/memory_sanitizer');

// Only the runtime's validated, visibility-filtered output enters memory.
function describe(run, execution) {
  const datasets = Object.entries(execution.result || {}).filter(([, value]) => Array.isArray(value));
  const bindings = Object.values(run.definition.bindings || {});
  const source = bindings.find(binding => binding.dbSourceId);
  const table = source?.tables?.length === 1 ? source.tables[0].split('.').pop() : null;
  return {
    runId: run.id, templateId: run.templateId, name: execution.name,
    inputs: execution.inputs, status: run.status, updatedAt: run.updatedAt,
    table, dbSourceId: source?.dbSourceId || null,
    datasets: datasets.map(([field, rows]) => ({ field, rowCount: rows.length,
      columns: execution.presentation?.columns?.[field] || Object.keys(rows[0] || {}),
      preview: rows.slice(0, 5) })),
    result: Object.fromEntries(Object.entries(execution.result || {}).filter(([, value]) => !Array.isArray(value)))
  };
}

function persist(run, execution, memory = require('../memory_core').memoryService) {
  if (run.status !== 'SUCCEEDED') return { persisted: false, reason: 'workflow_incomplete' };
  const governance = require('../governance/context');
  // Finalization runs in a new worker context. Restore all bound resources,
  // rather than inheriting an empty resource list from the final step.
  if (governance.current()) {
    for (const binding of Object.values(run.definition.bindings || {})) {
      const type = binding.dbSourceId ? 'sql' : binding.documentId ? 'document' : null;
      if (!type) continue;
      const resource = type === 'sql'
        ? require('../services/sql_connector').dbSources.find(item => item.id === binding.dbSourceId)
        : require('../knowledge_core/services/library_service').documents.find(item => item.id === binding.documentId);
      if (!resource || !governance.canRead(resource)) return { persisted: false, reason: 'workflow_source_unavailable' };
      governance.read(resource, type);
    }
  }
  return memory.persistWorkflowExchange({ sessionId: run.conversationId, accountId: run.ownerId,
    workflow: sanitizeObject(describe(run, execution)), artifacts: execution.artifacts || [] });
}

async function readRun(runId, context, automation = require('./index')) {
  const session = context.session;
  if (!session?.accountId || !session.id) throw new Error('An authenticated conversation is required.');
  const run = await automation.runtime.owned(runId, { accountId: session.accountId, permissions: context.permissions || [] });
  if (run.conversationId !== session.id || run.status !== 'SUCCEEDED') throw new Error('Workflow result is unavailable in this conversation.');
  if (!await automation.registry.canContinue(run.definition, { accountId: session.accountId,
    tenantId: session.tenantId, permissions: context.permissions || [] })) throw new Error('Workflow permission was revoked.');
  const { isValid } = require('../memory_core/reference_store');
  if (!isValid({ updatedAt: run.updatedAt })) throw new Error('Workflow result reference has expired.');
  return automation.runtime.view(run);
}

async function readDataset(args, context, automation = require('./index')) {
  const view = await readRun(args.runId, context, automation);
  const datasets = Object.entries(view.result || {}).filter(([, value]) => Array.isArray(value));
  const selected = args.field ? datasets.find(([field]) => field === args.field) : datasets.length === 1 ? datasets[0] : null;
  if (!selected) throw new Error('Specify a dataset field from the workflow result.');
  return { field: selected[0], rows: selected[1] };
}

async function verifyChart(args, context) {
  const runId = context.workflowRunId || context.memoryDecision?.reference?.data?.runId;
  if (!runId) return;
  const dataset = await readDataset({ runId, field: context.memoryDecision?.reference?.data?.field }, context);
  if (!require('../agent_core/harness/completion_policy').validateOutputData('render_chart', args,
    [{ result: { rows: dataset.rows } }])) throw new Error('Chart values must match the verified workflow dataset.');
}

module.exports = { describe, persist, readRun, readDataset, verifyChart };
