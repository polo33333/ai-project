'use strict';

const StorageHelper = require('../utils/storage_helper');
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
    this.store = options.store || StorageHelper.loadJson('conversation_memory.json', { sessions: {} });
    if (!this.store || typeof this.store !== 'object' || Array.isArray(this.store)) this.store = { sessions: {} };
    if (!this.store.sessions || typeof this.store.sessions !== 'object') this.store.sessions = {};
    this.maxStored = Math.max(4, Number.parseInt(process.env.AI_MEMORY_MAX_MESSAGES || '40', 10));
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
      summary: typeof value.summary === 'string' ? value.summary : '',
      messages: Array.isArray(value.messages) ? value.messages : [],
      activeScope: value.activeScope || null,
      lastPlan: value.lastPlan || null,
      references: { ...emptyReferences(), ...(value.references || {}) },
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

  getSession(sessionId, create = false, accountId = null) {
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
    const source = session?.messages?.length ? session.messages : decision.fallbackHistory;
    const limit = Math.max(1, Number(decision.maxMessages) || policy.recentMaxMessages());
    return sanitizeMessages(Array.isArray(source) ? source.slice(-limit) : []);
  }

  getLegacyContext(sessionId, fallbackHistory = [], limit = 10, accountId = null) {
    const session = this.getSession(sessionId, false, accountId);
    const source = session?.messages?.length ? session.messages : fallbackHistory;
    return sanitizeMessages(Array.isArray(source) ? source.slice(-limit) : []);
  }

  persistSuccessfulExchange({ sessionId, accountId = null, question, reply, currentPlan, toolCalls = [], completionStatus, responseEvaluation } = {}) {
    if (policy.isEnabled() && !policy.canPersist({ completionStatus, responseEvaluation })) return { persisted: false, reason: 'quality_gate_rejected' };
    const userMessage = sanitizeMessage({ role: 'user', content: question }, 20000);
    const assistantMessage = sanitizeMessage({ role: 'assistant', content: reply }, 30000);
    if (!userMessage || !assistantMessage) return { persisted: false, reason: 'sanitizer_rejected' };

    const session = this.getSession(sessionId, true, accountId);
    if (!session) return { persisted: false, reason: 'invalid_session' };
    const now = new Date().toISOString();
    userMessage.timestamp = now;
    assistantMessage.timestamp = now;
    session.messages.push(userMessage, assistantMessage);
    if (session.messages.length > this.maxStored) session.messages = session.messages.slice(-this.maxStored);
    session.lastPlan = sanitizeObject(currentPlan || null);
    session.activeScope = policy.getDomain(currentPlan?.table);
    session.references = { ...emptyReferences(), ...session.references, ...deriveReferences({ currentPlan, toolCalls, now }) };
    session.updatedAt = now;
    this.pruneSessions();
    this.persist();
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
    const session = id ? this.getSession(id, false, accountId) : null;
    if (!id || !session) return false;
    delete this.store.sessions[session._storageKey || id];
    this.persist();
    return true;
  }
}

module.exports = { MemoryService, emptyReferences };
