'use strict';

function buildSelectedKnowledgeMessages(systemPrompt, userMessage) {
  return [
    { role: 'system', content: String(systemPrompt || '') },
    { role: 'user', content: String(userMessage || '') }
  ];
}

module.exports = { buildSelectedKnowledgeMessages };
