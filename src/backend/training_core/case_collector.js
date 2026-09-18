'use strict';

const fs = require('fs');
const storage = require('../storage');
const StorageHelper = require('../utils/storage_helper');

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function collectCases({ historyFile, feedbackFile, reviewStatus = null } = {}) {
  const history = storage.enabled() ? StorageHelper.loadJson('chat_history.json', []) : readJson(historyFile, []);
  const feedback = storage.enabled() ? StorageHelper.loadJson('chat_feedback.json', []) : readJson(feedbackFile, []);
  const feedbackByAudit = new Map(feedback.map(item => [item.auditId, item]));
  return history.map(record => {
    const review = feedbackByAudit.get(record.id) || null;
    return {
      id: record.id,
      timestamp: record.timestamp,
      question: record.question,
      reply: record.replyText,
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
