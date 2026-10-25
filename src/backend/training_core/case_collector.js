'use strict';

const fs = require('fs');
const storage = require('../storage');
const StorageHelper = require('../utils/storage_helper');

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function collectCases({ historyFile, feedbackFile, reviewStatus = null, history: suppliedHistory, feedback: suppliedFeedback } = {}) {
  const history = suppliedHistory || (storage.enabled() ? StorageHelper.loadJson('chat_history.json', []) : readJson(historyFile, []));
  const feedback = suppliedFeedback || (storage.enabled() ? StorageHelper.loadJson('chat_feedback.json', []) : readJson(feedbackFile, []));
  const feedbackByAudit = new Map(feedback.map(item => [item.auditId, item]));
  // The previous turn of the same conversation, for history contamination checks.
  const conversationOf = record => {
    const payload = record.requestPayload || {};
    const sessionId = payload.sessionId || payload.memoryDecision?.sessionId;
    return sessionId ? `${payload.principalRef || payload.memoryDecision?.accountId || ''}|${sessionId}` : null;
  };
  const previousById = new Map();
  const lastByConversation = new Map();
  for (const record of [...history].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))) {
    const key = conversationOf(record);
    if (!key) continue;
    if (lastByConversation.has(key)) previousById.set(record.id, lastByConversation.get(key));
    lastByConversation.set(key, { question: record.question, reply: record.replyText });
  }
  return history.map(record => {
    const review = feedbackByAudit.get(record.id) || null;
    return {
      id: record.id,
      timestamp: record.timestamp,
      question: record.question,
      reply: record.replyText,
      previousTurn: previousById.get(record.id) || null,
      sql: record.sqlQuery,
      toolCalls: record.requestPayload?.toolCalls || [],
      selectedTables: record.requestPayload?.contextSelection?.selectedTables || [],
      memoryDecision: record.requestPayload?.memoryDecision || null,
      memoryPersisted: record.requestPayload?.memoryPersisted === true,
      pendingTurnRecorded: record.requestPayload?.pendingTurnRecorded === true,
      skill: record.requestPayload?.diagnostics?.skill || null,
      completionStatus: record.status,
      rating: review?.rating || null,
      reviewStatus: review?.reviewStatus || null
    };
  }).filter(item => !reviewStatus || item.reviewStatus === reviewStatus);
}

module.exports = { collectCases, readJson };
