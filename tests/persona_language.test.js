'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('system prompt keeps Vietnamese for greetings and short English words', () => {
  const prompt = require('../src/backend/assistant/ai_persona_service').buildSystemPrompt('', []);
  assert.match(prompt, /mặc định luôn dùng tiếng Việt/);
  assert.match(prompt, /"hi", "hello", "ok", "thanks"\) không tính là hỏi bằng tiếng Anh/);
  // The old exception let a bare "hi" switch the answer to English.
  assert.doesNotMatch(prompt, /trừ khi người dùng hỏi bằng tiếng Anh/);
});
