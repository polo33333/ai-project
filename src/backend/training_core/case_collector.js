'use strict';

const fs = require('fs');

function readJson(file, fallback = []) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function collectCases({ historyFile, feedbackFile, reviewStatus = null } = {}) {
  const history = readJson(historyFile, []);
  const feedback = readJson(feedbackFile, []);
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
