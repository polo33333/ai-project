'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function parseInline(value) {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const start = source.indexOf('function escapeChatMarkdown');
  const end = source.indexOf('\nfunction splitMarkdownTableRow', start);
  const context = vm.createContext({ URL });
  vm.runInContext(`${source.slice(start, end)}\nthis.result = parseMarkdownInline(${JSON.stringify(value)});`, context);
  return context.result;
}

test('bare HTTP URLs become safe clickable links', () => {
  const html = parseInline('Link: https://play.google.com/store/apps/details?id=com.tpsoft.ipms');
  assert.match(html, /class="chat-answer-link"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('markdown links are not nested by bare URL conversion', () => {
  const html = parseInline('[Google Play](https://play.google.com/app)');
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.match(html, />Google Play<\/a>/);
});

test('trailing punctuation stays outside the URL', () => {
  const html = parseInline('Mở https://example.com/app.');
  assert.match(html, /href="https:\/\/example\.com\/app"/);
  assert.match(html, /<\/a>\.$/);
});
