'use strict';
const governance = require('./context');
const fail = code => Object.assign(new Error(code), { code, statusCode: 403 });
const catalogCache = new Map();
const discovery = require('./workflow_discovery');
function catalogKey(context, identity) {
  return JSON.stringify([identity.accountId, identity.tenantId || null, context.session?.id,
    [...identity.permissions].sort(), governance.principal()?.role]);
}
function fingerprint(definitions) {
  return require('node:crypto').createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
}
function summary(definitions) {
  return definitions.map(discovery.brief);
}
function operations(definition) { return discovery.operations(definition); }
async function cachedCatalog(context) {
  const principal=governance.current()&&governance.principal();
  if (principal?.role!=='admin'&&principal?.permissions&&!principal.permissions.includes('workflows.use')) return null;
  if (!context.session?.id || !context.session?.accountId) return null;
  await governance.refresh();
  const automation = require('../automation'), identity = actor(context), key = catalogKey(context, identity);
  const cached = catalogCache.get(key);
  if (!cached || cached.expiresAt < Date.now()) { catalogCache.delete(key); return null; }
  if (!(await automation.settings()).enabled) { catalogCache.delete(key); return null; }
  const definitions = (await automation.registry.list(identity)).filter(definition => { try { readOnly(definition); return true; } catch { return false; } });
  if (cached.fingerprint !== fingerprint(definitions)) { catalogCache.delete(key); return null; }
  return structuredClone(cached.catalog);
}
function actor(context) {
  const principal = governance.principal();
  const accountId = context.session?.accountId || context.accountId;
  if (!principal || !accountId || principal.subject !== (accountId.startsWith('embed:') ? accountId : `account:${accountId}`)) throw fail('WORKFLOW_PRINCIPAL_MISMATCH');
  return { accountId, permissions: principal.role === 'admin' ? ['admin'] : (context.permissions || []).filter(permission => !['admin', '*'].includes(permission)), tenantId: context.session?.tenantId };
}
function readOnly(definition) {
  for (const binding of Object.values(definition.bindings || {})) if (require('../automation/data_sources').kind(binding) !== 'sql') require('../automation/read_only_policy').assertSourceAllowed(binding);
}
async function delivery(runId, context) {
  const automation = require('../automation'), identity = actor(context);
  const run = await automation.runtime.owned(runId, identity);
  if (run.conversationId !== context.session?.id) throw fail('WORKFLOW_CONVERSATION_MISMATCH');
  if (!await automation.registry.canContinue(run.definition, identity)) throw fail('WORKFLOW_PERMISSION_REVOKED');
  for (const binding of Object.values(run.definition.bindings || {})) {
    const type = require('../automation/data_sources').kind(binding);
    if (type === 'sql') {
      const source = require('../services/sql_connector').dbSources.find(item => item.id === binding.dbSourceId);
      if (!source) throw fail('WORKFLOW_SOURCE_REVOKED'); governance.read(source, 'sql');
    } else if (type === 'file') {
      const document = require('../knowledge_core/services/library_service').documents.find(item => item.id === binding.documentId);
      if (!document) throw fail('WORKFLOW_SOURCE_REVOKED'); governance.read(document, 'document');
    }
  }
  await governance.refresh();
  const execution = automation.runtime.view(run);
  return { ...execution, templateVersion: execution.packageVersion || null };
}
async function execute(name, args, context) {
  await governance.refresh();
  const automation = require('../automation'); await automation.settings();
  const identity = actor(context), runtime = automation.runtime;
  const principal=governance.principal();
  if(principal.role!=='admin'&&principal.permissions&&!principal.permissions.includes('workflows.use')) {
    if(name==='list_workflows') return {workflows:[],pendingRuns:[],disabled:true};
    throw fail('WORKFLOW_PERMISSION_REVOKED');
  }
  if (name === 'list_workflows') {
    if (!(await automation.settings()).enabled) return { workflows: [], pendingRuns: [], disabled: true };
    const definitions = (await automation.registry.list(identity)).filter(definition => { try { readOnly(definition); return true; } catch { return false; } });
    const offset = args.offset || 0, limit = Math.min(args.limit || 5, 30);
    if (!args.templateId && offset === 0 && definitions.length <= 5) {
      const key = catalogKey(context, identity);
      if (catalogCache.size >= 200) catalogCache.delete(catalogCache.keys().next().value);
      catalogCache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, fingerprint: fingerprint(definitions), catalog: summary(definitions) });
    }
    const pending = await runtime.pending(identity, context.session?.id);
    return { ...discovery.discover(definitions, { ...args, offset, limit, query: args.query || context.userMessage || '' }),
      pendingRuns: pending ? [{ runId: pending.id, templateId: pending.templateId, status: pending.status, revision: pending.revision, missingInputs: pending.missing }] : [],
      };
  }
  let execution;
  if (name === 'run_workflow') {
    const definition = await automation.registry.getTemplate(args.templateId, identity); readOnly(definition);
    if (context.governedController) {
      if (typeof context.assessWorkflow !== 'function') throw fail('WORKFLOW_ASSESSMENT_REQUIRED');
      const assessment = await context.assessWorkflow(definition, args.inputs || {}, { planned: context.plannedWorkflow === args.templateId });
      if (Array.isArray(assessment?.confirmedSlots)) args.inputs = Object.fromEntries(Object.entries(args.inputs || {})
        .filter(([key]) => assessment.confirmedSlots.includes(key)));
    }
    const conversationId = context.session?.id;
    if (!conversationId) throw fail('WORKFLOW_CONVERSATION_REQUIRED');
    execution = await runtime.create(args.templateId, args.inputs || {}, identity, { conversationId, requestId: governance.current()?.requestId, preservePending: true });
  } else {
    const run = await runtime.owned(args.runId, identity);
    if (run.conversationId !== context.session?.id) throw fail('WORKFLOW_CONVERSATION_MISMATCH');
    if (!await automation.registry.canContinue(run.definition, identity)) throw fail('WORKFLOW_PERMISSION_REVOKED');
    if (name !== 'cancel_workflow') readOnly(run.definition);
    if (name === 'get_workflow_status') execution = runtime.view(run);
    else if (name === 'cancel_workflow') execution = await runtime.cancel(run.id, identity, args.revision);
    else if (name === 'resume_workflow') execution = args.inputs ? await runtime.inputs(run.id, args.inputs, identity, args.revision) : await runtime.resume(run.id, identity, args.revision);
    else throw fail('WORKFLOW_TOOL_UNKNOWN');
  }
  const templateVersion = execution.packageVersion || execution.templateVersion || null;
  const bounded = Object.fromEntries(['id', 'runId', 'revision', 'status', 'templateId', 'name', 'conversationId', 'packageVersion', 'overlayVersion', 'missingInputs', 'inputLabels', 'actions', 'steps', 'error', 'createdAt', 'updatedAt'].map(key => [key, execution[key]]));
  bounded.templateVersion = templateVersion;
  return { runId: execution.id, templateVersion, status: execution.status,
    execution: bounded, outputRef: execution.status === 'SUCCEEDED' ? `workflow:${execution.id}:result` : null };
}
async function pendingInput(context) {
  if (!context.session?.id || !context.session?.accountId) return null;
  const principal=governance.current()&&governance.principal();
  if (principal?.role!=='admin'&&principal?.permissions&&!principal.permissions.includes('workflows.use')) return null;
  await governance.refresh();
  const automation = require('../automation'), identity = actor(context);
  if (!(await automation.settings()).enabled) return null;
  const run = await automation.runtime.pending(identity, context.session?.id);
  if (!run || run.status !== 'WAITING_INPUT' || !await automation.registry.canContinue(run.definition, identity)) return null;
  readOnly(run.definition);
  return { runId: run.id, revision: run.revision, templateId: run.templateId, name: run.definition.name,
    inputs: Object.fromEntries(Object.entries(run.definition.inputs || {}).filter(([key]) => run.missing.some(item => item.key === key))) };
}
module.exports = { execute, readOnly, actor, delivery, cachedCatalog, pendingInput };
