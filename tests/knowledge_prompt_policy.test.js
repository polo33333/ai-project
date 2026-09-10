'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSelectedKnowledgeMessages } = require('../src/backend/intelligent_core/knowledge_prompt_policy');

test('selected knowledge prompt contains only the current question', () => {
  const messages = buildSelectedKnowledgeMessages('Selected document context', 'cách tải app');
  assert.deepEqual(messages, [
    { role: 'system', content: 'Selected document context' },
    { role: 'user', content: 'cách tải app' }
  ]);
  assert.equal(messages.some(message => /giá vàng|45\s*\+\s*45/i.test(message.content)), false);
});
