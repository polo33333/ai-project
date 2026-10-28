'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildSqlRowsFallbackReply } = require('../src/backend/agent/harness/grounded_reply');
test('chat, popup and standalone embed retain escaped pipes, missing fields and safe HTML in result tables', () => {
  const reply = buildSqlRowsFallbackReply({ result: { rows: [{ code: 'A', value: 'a|b', empty: null },
    { code: 'B', value: '<script>unsafe</script>', later: 'present' }] } }, {}, { forceTable: true });
  const page = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(page.slice(page.indexOf('function escapeChatMarkdown'), page.indexOf('// Render Chart.js')), context);
  const app = fs.readFileSync('src/frontend/shared/js/app.js', 'utf8');
  vm.runInContext(app.slice(app.indexOf('function renderCopilotText'), app.indexOf('function renderCopilotDownloadAction')), context);
  const embed = fs.readFileSync('src/frontend/embed-client/knowledgehub-chat.js', 'utf8');
  const standalone = vm.createContext({ URL, apiBase: 'http://localhost' });
  vm.runInContext(embed.slice(embed.indexOf('  const escapeHtml'), embed.indexOf('  const chartColors')) + '\nthis.render = renderRichText;', standalone);
  for (const html of [context.parseMarkdown(reply), context.renderCopilotText(reply), standalone.render(reply)]) {
    assert.ok(html.includes('a|b'));
    assert.ok(html.includes('Chưa truy vấn'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(!html.includes('<script>'));
    assert.equal((html.match(/<td(?:\s|>)/g) || []).length, 8);
  }
});
test('one-column aggregate tables render as a table on chat, popup and embed', () => {
  const reply = '| Tổng tiền (VNĐ) |\n| --- |\n| 441529638 |';
  const page = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8'), context = vm.createContext({ URL });
  vm.runInContext(page.slice(page.indexOf('function escapeChatMarkdown'), page.indexOf('// Render Chart.js')), context);
  const app = fs.readFileSync('src/frontend/shared/js/app.js', 'utf8');
  vm.runInContext(app.slice(app.indexOf('function renderCopilotText'), app.indexOf('function renderCopilotDownloadAction')), context);
  const embed = fs.readFileSync('src/frontend/embed-client/knowledgehub-chat.js', 'utf8'), standalone = vm.createContext({ URL, apiBase: 'http://localhost' });
  vm.runInContext(embed.slice(embed.indexOf('  const escapeHtml'), embed.indexOf('  const chartColors')) + '\nthis.render = renderRichText;', standalone);
  for (const html of [context.parseMarkdown(reply), context.renderCopilotText(reply), standalone.render(reply)]) {
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('<td'));
    assert.ok(!html.includes('| --- |'));
  }
});
test('declared numeric units use Vietnamese formatting without changing source data or IDs', () => {
  const rows = [{ Amount: 441529638, ID: 12345 }];
  const reply = buildSqlRowsFallbackReply({ result: { rows, units: { Amount: 'VNĐ' } } });
  assert.ok(reply.includes('441.529.638'));
  assert.ok(reply.includes('12345'));
  assert.equal(rows[0].Amount, 441529638);
});
