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

test('internal paths are hidden while application download links remain', () => {
  const html=parseInline('[Tải](/api/exports/report.xlsx) (file:///C:/Users/Admin/AppData/Local/Temp/api_uploads/report.xlsx)');
  assert.match(html,/href="\/api\/exports\/report.xlsx"/);
  assert.doesNotMatch(html,/file:|AppData|api_uploads|C:\//i);
  for(const path of ['C:\\Users\\Admin\\secret.txt','/home/admin/secret.txt','\\\\server\\share\\secret.txt']) {
    assert.doesNotMatch(parseInline(path),/secret\.txt|admin|server/i);
    assert.doesNotMatch(require('../src/backend/intelligent_core/security_guard').maskSensitiveData(path),/secret\.txt|admin|server/i);
  }
});

test('modal and standalone embed renderers hide paths while retaining export links',()=>{
  const value='[Tải](/api/exports/report.xlsx) (file:///C:/Users/Admin/AppData/Local/Temp/report.xlsx)';
  const page=fs.readFileSync('src/frontend/js/modules/page_chat.js','utf8');
  const app=fs.readFileSync('src/frontend/js/app.js','utf8');
  const modal=vm.createContext({parseMarkdown:parseInline});
  vm.runInContext(page.slice(page.indexOf('function sanitizeSystemPaths'),page.indexOf('function parseMarkdownInline')),modal);
  vm.runInContext(app.slice(app.indexOf('function renderCopilotText'),app.indexOf('function renderCopilotDownloadAction')),modal);
  const modalHtml=vm.runInContext(`renderCopilotText(${JSON.stringify(value)})`,modal);
  const embed=fs.readFileSync('src/frontend/embed/knowledgehub-chat.js','utf8');
  const standalone=vm.createContext({URL,apiBase:'https://chat.example.com'});
  vm.runInContext(embed.slice(embed.indexOf('  const escapeHtml'),embed.indexOf('  const markdownCells'))+`\nthis.result=renderText(${JSON.stringify(value)});`,standalone);
  for(const html of [modalHtml,standalone.result]) {
    assert.doesNotMatch(html,/file:|AppData|C:\/Users|Local\/Temp/i);
    assert.match(html,/href="(?:https:\/\/chat.example.com)?\/api\/exports\/report.xlsx"/);
  }
});

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

test('chat result renderers convert ISO database dates to Vietnamese display format', () => {
  const page = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const pageContext = vm.createContext({});
  const pageStart = page.indexOf('function formatChatDisplayValue');
  const pageEnd = page.indexOf('\nfunction renderMarkdownTable', pageStart);
  vm.runInContext(`${page.slice(pageStart, pageEnd)}\nthis.dateOnly=formatChatDisplayValue('2002-05-24T00:00:00.000Z');this.dateTime=formatChatDisplayValue('2026-09-20T14:30:45.000Z');`, pageContext);
  assert.equal(pageContext.dateOnly, '24/05/2002');
  assert.equal(pageContext.dateTime, '20/09/2026 14:30:45');

  const embed = fs.readFileSync('src/frontend/embed/knowledgehub-chat.js', 'utf8');
  assert.match(embed, /formatDisplayValue\(row\[cellIndex\]/);
  assert.match(embed, /escapeHtml\(formatDisplayValue\(cell\)\)/);
});
