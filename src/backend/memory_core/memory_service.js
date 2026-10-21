'use strict';

const StorageHelper = require('../utils/storage_helper');
const crypto = require('node:crypto');
const policy = require('./memory_policy');
const { routeMemory } = require('./memory_router');
const { deriveReferences } = require('./reference_store');
const { sanitizeMessage, sanitizeMessages, sanitizeObject } = require('./memory_sanitizer');

function emptyReferences() {
  return { lastEntity: null, lastDataset: null, lastExport: null };
}

class MemoryService {
  constructor(options = {}) {
    this._save = options.save || (store => StorageHelper.saveJson('conversation_memory.json', store));
    if (options.store) this.store = options.store;
    else StorageHelper.bind(this, 'store', 'conversation_memory.json', { sessions: {} }, store => {
      for (const [id, session] of Object.entries(store.sessions || {})) store.sessions[id] = this.migrateSession(session, id);
      return store;
    });
    if (!this.store || typeof this.store !== 'object' || Array.isArray(this.store)) this.store = { sessions: {} };
    if (!this.store.sessions || typeof this.store.sessions !== 'object') this.store.sessions = {};
    this.maxStored = Math.max(4, Number.parseInt(process.env.AI_MEMORY_MAX_MESSAGES || '40', 10));
    this.maxStored -= this.maxStored % 2;
    this.maxSessions = Math.max(20, Number.parseInt(process.env.AI_MEMORY_MAX_SESSIONS || '500', 10));
    this.migrateStore();
  }

  normalizeSessionId(sessionId) {
    const clean = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
    return clean || null;
  }

  migrateSession(session, id) {
    const value = session && typeof session === 'object' ? session : {};
    return {
      ...value,
      id: value.id || id,
      summary: typeof value.summary === 'string' || (value.summary && typeof value.summary === 'object') ? value.summary : '',
      messages: Array.isArray(value.messages) ? value.messages : [],
      activeScope: value.activeScope || null,
      lastPlan: value.lastPlan || null,
      references: { ...emptyReferences(), ...(value.references || {}) },
      pendingTurn: value.pendingTurn && typeof value.pendingTurn === 'object' ? value.pendingTurn : null,
      createdAt: value.createdAt || new Date().toISOString(),
      updatedAt: value.updatedAt || value.createdAt || new Date().toISOString()
    };
  }

  migrateStore() {
    for (const [id, session] of Object.entries(this.store.sessions)) {
      this.store.sessions[id] = this.migrateSession(session, id);
    }
    return this.store;
  }

  persist() { this._save(this.store); }

  setDocumentState(sessionId, accountId, state) {
    const session = this.getSession(sessionId, Boolean(state), accountId);
    if (!session) return;
    if (!state && !session.documentState) return;
    session.documentState = state;
    session.updatedAt = new Date().toISOString();
    this.pruneSessions();
    this.persist();
  }

  getSession(sessionId, create = false, accountId = null, allowInvalid = false) {
    const id = this.normalizeSessionId(sessionId);
    if (!id) return null;
    const cleanAccountId = this.normalizeSessionId(accountId);
    const scopedKey = cleanAccountId ? `${cleanAccountId}__${id}` : id;
    let storageKey = scopedKey;
    let session = this.store.sessions[scopedKey] || null;
    if (!session && cleanAccountId && this.store.sessions[id]?.accountId === accountId) {
      session = this.store.sessions[id];
      storageKey = id;
    }
    if (!session && create) {
      session = this.migrateSession({ accountId: accountId || null }, id);
      this.store.sessions[scopedKey] = session;
      storageKey = scopedKey;
    }
    if (session && cleanAccountId && session.accountId !== accountId) return null;
    const governance = require('../governance/context');
    if (session && governance.current() && !allowInvalid) {
      const refs = session.governedResources || [];
      let valid = !session.governedScope || session.governedScope === governance.principal().subject;
      for (const ref of refs) {
        const resource = ref.type === 'sql' ? require('../services/sql_connector').dbSources.find(item => item.id === ref.id)
          : require('../knowledge_core/services/library_service').documents.find(item => item.id === ref.id);
        if (!resource || !governance.canRead(resource) || (resource.governedPolicy?.revision || 0) !== ref.revision) { valid = false; break; }
        governance.read(resource, ref.type);
      }
      // Invalidate conversational data, never cancel the independent durable run.
      if (!valid) {
        if (!create) return null;
        session = this.migrateSession({ accountId: accountId || null }, id);
        this.store.sessions[storageKey] = session;
      }
    }
    if (session) Object.defineProperty(session, '_storageKey', { value: storageKey, configurable: true, enumerable: false });
    return session;
  }

  route({ sessionId, accountId = null, question, currentPlan, fallbackHistory = [], now } = {}) {
    const session = this.getSession(sessionId, false, accountId);
    const decision = routeMemory({ currentPlan, session, question, fallbackHistory, now });
    return { ...decision, sessionId: this.normalizeSessionId(sessionId), accountId };
  }

  getContext(decision = {}) {
    if (typeof decision === 'string') {
      return this.getLegacyContext(decision, arguments[1], arguments[2], arguments[3]);
    }
    if (decision.mode === 'none') return [];
    if (decision.mode === 'reference') {
      if (!decision.reference?.type) return [];
      return [{
        role: 'system',
        content: `Structured memory reference (${decision.reference.type}): ${JSON.stringify(sanitizeObject(decision.reference.data))}`
      }];
    }
    const session = this.getSession(decision.sessionId, false, decision.accountId);
    const stored = session?.messages?.length ? session.messages : null;
    const effectiveScope = decision.currentScope || session?.activeScope || null;
    const source = stored && effectiveScope
      ? stored.filter(message => !message.scope || message.scope === effectiveScope)
      : (stored || decision.fallbackHistory);
    const limit = Math.max(1, Number(decision.maxMessages) || policy.recentMaxMessages());
    const messages = sanitizeMessages(Array.isArray(source) ? source.slice(-limit) : []);
    if (policy.summaryEnabled() && session?.summary && effectiveScope
        && session.summary.scope === effectiveScope) {
      messages.unshift({ role: 'system', content: `Verified conversation state: ${JSON.stringify(sanitizeObject(session.summary))}` });
    }
    if (policy.pendingTurnEnabled() && this.isPendingTurnValid(session?.pendingTurn)
        && (!session.pendingTurn.scope || session.pendingTurn.scope === effectiveScope)) {
      messages.unshift({ role: 'system', content: `Yêu cầu trước chưa hoàn tất: ${session.pendingTurn.question}` });
    }
    return messages;
  }

  getResolutionContext(decision = {}, currentPlan = {}) {
    const session = this.getSession(decision.sessionId, false, decision.accountId);
    if (!policy.isEnabled() || !session) return { candidates: [], recent: [] };
    const candidates = [];
    const pending = policy.pendingTurnEnabled() && this.isPendingTurnValid(session.pendingTurn) ? session.pendingTurn : null;
    const referenceCutoff = pending ? Date.parse(pending.updatedAt) : 0;
    const fresh = value => value?.updatedAt && Date.parse(value.updatedAt) <= Date.now()
      && Date.parse(value.updatedAt) >= referenceCutoff
      && Date.now() - Date.parse(value.updatedAt) <= policy.referenceTtlMinutes() * 60000
      && (!currentPlan.dbSourceId || !value.dbSourceId || currentPlan.dbSourceId === value.dbSourceId)
      && require('./durable_memory').memory.resourcesAllowed(value, true);
    const dataset = session.references.lastDataset;
    for (const item of (session.entityReferences || []).filter(fresh).slice(-12)) {
      // Older workflow memory stored full preview rows as filters. Expose only its run reference,
      // never reuse those business values as an identity or as current evidence.
      if (item.runId) {
        if (!candidates.some(candidate => candidate.data.runId === item.runId)) candidates.push({
          id: `workflow:prior:${item.runId}`, kind: 'workflow', data: { runId: item.runId, table: item.table,
            dbSourceId: item.dbSourceId, updatedAt: item.updatedAt } });
      } else candidates.push({ id: `entity:${candidates.length}`, kind: 'entity', data: item });
    }
    if (!candidates.length && fresh(dataset)) for (const key of (dataset.entityKeys || []).slice(0, 12)) {
      candidates.push({ id: `entity:${candidates.length}`, kind: 'entity', data: {
        table: dataset.table, dbSourceId: dataset.dbSourceId, runId: dataset.runId, key,
        updatedAt: dataset.updatedAt } });
    }
    const entity = session.references.lastEntity;
    if (!candidates.length && fresh(entity) && !entity.runId) candidates.push({ id: 'entity:0', kind: 'entity', data: {
      table: entity.table, dbSourceId: entity.dbSourceId, runId: entity.runId,
      filters: entity.filters, updatedAt: entity.updatedAt } });
    if (fresh(dataset)) candidates.push({ id: 'dataset:latest', kind: 'dataset', data: {
      table: dataset.table, dbSourceId: dataset.dbSourceId, runId: dataset.runId, field: dataset.field,
      rowCount: dataset.rowCount, columns: dataset.columns || dataset.requiredColumns || [], updatedAt: dataset.updatedAt } });
    const recent = sanitizeMessages(session.messages.slice(-4), 1000);
    if (pending) recent.push({ role: 'user', content: pending.question }, { role: 'assistant', content: 'Yêu cầu này chưa hoàn tất; chưa có tham chiếu đối tượng được xác minh cho lượt này.' });
    return { candidates, recent, referenceCutoff,
      previousRequest: session.conversationState ? { operation: session.conversationState.operation,
        cardinality: session.conversationState.cardinality, requestedAttributes: session.conversationState.requestedAttributes,
        businessState: fresh(session.businessState) ? session.businessState : undefined } : null };
  }

  captureEntities(session) {
    const dataset = session.references.lastDataset, entity = session.references.lastEntity;
    const keys = dataset?.entityKeys || (dataset?.preview
      ? require('./reference_store').datasetEntityKeys(dataset.preview) : []);
    const fresh = keys.length ? keys.map(key => ({ table: dataset.table, dbSourceId: dataset.dbSourceId,
      runId: dataset.runId, key, updatedAt: dataset.updatedAt })) : entity ? [{ table: entity.table,
      dbSourceId: entity.dbSourceId, runId: entity.runId, key: entity.filters, updatedAt: entity.updatedAt }] : [];
    const byIdentity = new Map();
    for (const item of [...(session.entityReferences || []), ...fresh.map(item => ({ ...item, resources: session.governedResources || [] }))]) {
      const key = JSON.stringify([item.dbSourceId, item.table, Object.entries(item.key || {}).sort()]);
      byIdentity.delete(key); byIdentity.set(key, item);
    }
    session.entityReferences = [...byIdentity.values()].slice(-20);
  }

  getAgentState(decision = {}, currentPlan = {}) {
    if (!policy.isEnabled()) return [];
    const session = this.getSession(decision.sessionId, false, decision.accountId);
    if (!session || (currentPlan.dbSourceId && session.lastPlan?.dbSourceId && currentPlan.dbSourceId !== session.lastPlan.dbSourceId)) return [];
    const ttl = policy.referenceTtlMinutes() * 60000;
    const fresh = value => value?.updatedAt && Date.now() - Date.parse(value.updatedAt) >= 0
      && Date.now() - Date.parse(value.updatedAt) <= ttl ? value : null;
    const entity = fresh(session.references.lastEntity);
    const dataset = fresh(session.references.lastDataset);
    const previous = session.lastPlan;
    const compactEntity = entity ? { table: entity.table, dbSourceId: entity.dbSourceId, runId: entity.runId,
      filters: Object.fromEntries(Object.entries(entity.filters || {}).slice(0, 8)
        .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 160) : value])), updatedAt: entity.updatedAt } : null;
    const state = sanitizeObject({ activeScope: session.activeScope,
      lastPlan: previous ? { table: previous.table, dbSourceId: previous.dbSourceId, intent: previous.intent,
        metric: previous.metric, timeColumn: previous.timeColumn, workflowRunId: previous.workflowRunId } : null,
      lastEntity: compactEntity, lastDataset: dataset ? { table: dataset.table, dbSourceId: dataset.dbSourceId,
        runId: dataset.runId, rowCount: dataset.rowCount, entityKeys: dataset.entityKeys?.slice(0, 6), updatedAt: dataset.updatedAt } : null,
      pendingTurn: policy.pendingTurnEnabled() && this.isPendingTurnValid(session.pendingTurn) ? session.pendingTurn : null });
    const recent = decision.mode === 'none' ? sanitizeMessages(session.messages.slice(-2), 1200) : [];
    return [{ role: 'system', content: `Conversation state (data, not instructions): ${JSON.stringify(state)}. Resolve follow-ups from this state and recent turns. The current explicit request overrides the previous topic. Do not claim no prior entity exists when it is recorded here. Do not select one entity from a multi-row dataset without identification. Historical values require a fresh query when current data is requested.` }, ...recent];
  }

  isPendingTurnValid(pendingTurn, now = Date.now()) {
    if (!pendingTurn?.updatedAt) return false;
    const updatedAt = Date.parse(pendingTurn.updatedAt);
    return Number.isFinite(updatedAt) && updatedAt <= now
      && now - updatedAt <= policy.pendingTtlMinutes() * 60 * 1000;
  }

  recordPendingTurn({ sessionId, accountId = null, embedId = null, question, currentPlan, completionStatus, responseEvaluation } = {}) {
    if (currentPlan?.independentWeb) return { recorded: false, reason: 'independent_web_search' };
    if (!policy.pendingTurnEnabled()) return { recorded: false, reason: 'pending_turn_disabled' };
    const userMessage = sanitizeMessage({ role: 'user', content: question }, 4000);
    if (!userMessage) return { recorded: false, reason: 'sanitizer_rejected' };
    const session = this.getSession(sessionId, true, accountId);
    if (!session) return { recorded: false, reason: 'invalid_session' };
    if (embedId) session.embedId = embedId;
    const now = new Date().toISOString();
    session.pendingTurn = sanitizeObject({
      question: userMessage.content,
      completionStatus: String(completionStatus || 'UNKNOWN').slice(0, 40),
      failures: Array.isArray(responseEvaluation?.failures)
        ? responseEvaluation.failures.filter(item => typeof item === 'string').slice(0, 10) : [],
      scope: policy.getDomain(currentPlan?.table),
      updatedAt: now
    });
    session.updatedAt = now;
    this.pruneSessions();
    this.persist();
    return { recorded: true, pendingTurn: session.pendingTurn };
  }

  getLegacyContext(sessionId, fallbackHistory = [], limit = 10, accountId = null) {
    const session = this.getSession(sessionId, false, accountId);
    const source = session?.messages?.length ? session.messages : fallbackHistory;
    return sanitizeMessages(Array.isArray(source) ? source.slice(-limit) : []);
  }

  persistWorkflowExchange({ sessionId, accountId, workflow, artifacts = [] }) {
    if (!policy.isEnabled()) return { persisted: false, reason: 'memory_disabled' };
    const previous = this.getSession(sessionId, false, accountId);
    if (previous?.lastWorkflowRun?.runId === workflow.runId) return { persisted: false, reason: 'already_recorded' };
    const result = this.persistSuccessfulExchange({ sessionId, accountId,
      question: `Nghiệp vụ: ${workflow.name}. Input: ${JSON.stringify(workflow.inputs)}`,
      reply: `Nghiệp vụ đã hoàn tất. ${JSON.stringify(workflow)}`,
      currentPlan: { table: workflow.table || `workflow:${workflow.templateId}`, dbSourceId: workflow.dbSourceId,
        intent: 'workflow', workflowRunId: workflow.runId },
      completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
    if (!result.persisted) return result;
    const session = result.session;
    session.lastWorkflowRun = workflow;
    require('./durable_memory').memory.recordEvent({ accountId, sessionId,
      question: `Nghiệp vụ: ${workflow.name}`, currentPlan: session.lastPlan, workflow,
      resources: session.governedResources || [] });
    session.messages.slice(-2).forEach(message => { message.workflowRunId = workflow.runId; });
    // Replace references so a new result cannot accidentally select an older entity/file.
    session.references = emptyReferences();
    if (!workflow.datasets.length && Object.keys(workflow.result || {}).length) session.references.lastEntity = {
      runId: workflow.runId, table: session.lastPlan.table, filters: workflow.result, updatedAt: workflow.updatedAt };
    if (workflow.datasets.length > 1) session.references.lastDataset = {
      runId: workflow.runId, datasets: workflow.datasets, table: session.lastPlan.table,
      dbSourceId: workflow.dbSourceId, updatedAt: workflow.updatedAt, workflow: true };
    if (workflow.datasets.length === 1) {
      const dataset = workflow.datasets[0];
      session.references.lastDataset = { ...dataset, runId: workflow.runId, table: session.lastPlan.table,
        dbSourceId: workflow.dbSourceId, updatedAt: workflow.updatedAt, workflow: true };
      if (dataset.rowCount === 1) session.references.lastEntity = {
        runId: workflow.runId, table: session.lastPlan.table, filters: dataset.preview[0], updatedAt: workflow.updatedAt };
    }
    if (artifacts.length === 1) session.references.lastExport = sanitizeObject({
      runId: workflow.runId, ...artifacts[0], updatedAt: workflow.updatedAt });
    this.captureEntities(session);
    this.persist();
    return result;
  }

  persistSuccessfulExchange({ sessionId, accountId = null, embedId = null, question, reply, currentPlan, toolCalls = [], completionStatus, responseEvaluation } = {}) {
    if (currentPlan?.independentWeb) return { persisted: false, reason: 'independent_web_search' };
    if (policy.isEnabled() && !policy.canPersist({ completionStatus, responseEvaluation })) return { persisted: false, reason: 'quality_gate_rejected' };
    const userMessage = sanitizeMessage({ role: 'user', content: question }, 20000);
    const assistantMessage = sanitizeMessage({ role: 'assistant', content: reply }, 30000);
    if (!userMessage || !assistantMessage) return { persisted: false, reason: 'sanitizer_rejected' };

    const session = this.getSession(sessionId, true, accountId);
    if (!session) return { persisted: false, reason: 'invalid_session' };
    if (embedId) session.embedId = embedId;
    const now = new Date().toISOString();
    userMessage.timestamp = now;
    assistantMessage.timestamp = now;
    userMessage.id = crypto.randomUUID();
    assistantMessage.id = crypto.randomUUID();
    const messageScope = policy.getDomain(currentPlan?.table);
    userMessage.scope = messageScope;
    assistantMessage.scope = messageScope;
    session.messages.push(userMessage, assistantMessage);
    const governance = require('../governance/context');
    if (governance.current()) {
      session.governedScope = governance.principal().subject;
      session.governedResources = [...governance.current().resources.values()].map(({ resource, type }) => ({ type, id: resource.id, revision: resource.governedPolicy?.revision || 0 }));
      session.memoryAssurance = 'conversation_only';
      assistantMessage.answerRevision = governance.current().finalEnvelope?.answerRevision || null;
    }
    if (session.messages.length > this.maxStored) session.messages = session.messages.slice(-this.maxStored);
    if (toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success && Array.isArray(call.result?.rows))) {
      session.references = emptyReferences();
      session.lastWorkflowRun = null;
    }
    session.lastPlan = sanitizeObject(currentPlan || null);
    session.activeScope = messageScope;
    session.references = { ...emptyReferences(), ...session.references, ...deriveReferences({ currentPlan, toolCalls, now }) };
    if (currentPlan?.conversationState) session.conversationState = { ...currentPlan.conversationState, updatedAt: now };
    session.businessState = require('./business_state').fromPlan(currentPlan || {}, now);
    this.captureEntities(session);
    session.pendingTurn = null;
    if (policy.summaryEnabled()) {
      session.summary = sanitizeObject({
        scope: session.activeScope,
        table: currentPlan?.table || null,
        metric: currentPlan?.metric || null,
        timeColumn: currentPlan?.timeColumn || null,
        updatedAt: now
      });
    }
    session.updatedAt = now;
    this.pruneSessions();
    this.persist();
    if (currentPlan?.workflowRunId || toolCalls.some(call => ['execute_sql_query', 'query_sql_metric'].includes(call.toolName) && call.success)) {
      require('./durable_memory').memory.recordEvent({ accountId, sessionId, question, currentPlan,
        resources: session.governedResources || [] });
    }
    return { persisted: true, session };
  }

  appendExchange(sessionId, userContent, assistantContent) {
    return this.persistSuccessfulExchange({
      sessionId, question: userContent, reply: assistantContent, currentPlan: null,
      completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }
    }).session || null;
  }

  pruneSessions() {
    const ids = Object.keys(this.store.sessions);
    if (ids.length <= this.maxSessions) return;
    ids.sort((a, b) => Date.parse(this.store.sessions[a].updatedAt || 0) - Date.parse(this.store.sessions[b].updatedAt || 0));
    ids.slice(0, ids.length - this.maxSessions).forEach(id => delete this.store.sessions[id]);
  }

  clearSession(sessionId, accountId = null) {
    const id = this.normalizeSessionId(sessionId);
    const session = id ? this.getSession(id, false, accountId, true) : null;
    if (!id || !session) return false;
    delete this.store.sessions[session._storageKey || id];
    this.persist();
    return true;
  }
}

module.exports = { MemoryService, emptyReferences };
