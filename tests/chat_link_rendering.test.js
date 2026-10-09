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

test('hidden system-path download lines are omitted completely', () => {
  const values = [
    'Nội dung trả lời.\n\n- Tải về tại: [Tải file tại đây]([SYSTEM_PATH_HIDDEN])',
    'Nội dung trả lời.\n\n- Tải về tại: [Tải file tại đây](file:///C:/Users/Admin/report.xlsx)'
  ];
  for (const value of values) {
    const html = parseInline(value);
    assert.match(html, /Nội dung trả lời/);
    assert.doesNotMatch(html, /SYSTEM_PATH_HIDDEN|Tải về tại|Tải file tại đây/);
  }
});

test('inline export link is removed when a separate download action is available', () => {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const start = source.indexOf('function stripInlineDownloadLink');
  const end = source.indexOf('\nfunction parseMarkdownInline', start);
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nthis.result = stripInlineDownloadLink('Đã xuất file thành công: [Tải file tại đây](/api/exports/report.xlsx).', '/api/exports/report.xlsx');`, context);
  assert.equal(context.result, 'Đã xuất file thành công.');
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
  const pageStart = page.indexOf('function isBooleanDisplayColumn');
  const pageEnd = page.indexOf('\nfunction renderMarkdownTable', pageStart);
  vm.runInContext(`${page.slice(pageStart, pageEnd)}\nthis.dateOnly=formatChatDisplayValue('2002-05-24T00:00:00.000Z');this.dateTime=formatChatDisplayValue('2026-09-20T14:30:45.000Z');this.yes=formatChatDisplayValue(1,'IsVAT');this.no=formatChatDisplayValue(false,'IsVAT');this.number=formatChatDisplayValue(0,'Quantity');`, pageContext);
  assert.equal(pageContext.dateOnly, '24/05/2002');
  assert.equal(pageContext.dateTime, '20/09/2026 14:30:45');
  assert.equal(pageContext.yes, 'Có');
  assert.equal(pageContext.no, 'Không');
  assert.equal(pageContext.number, '0');

  const embed = fs.readFileSync('src/frontend/embed/knowledgehub-chat.js', 'utf8');
  assert.match(embed, /formatDisplayValue\(row\[cellIndex\]/);
  assert.match(embed, /escapeHtml\(formatDisplayValue\(cell, data\.toolResult\.columns\[cellIndex\]\)\)/);
});

test('API examples survive reply cleaning while internal chart payloads are hidden', () => {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const start = source.indexOf('function cleanReplyText');
  const end = source.indexOf('function escapeChatMarkdown', start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  const clean = value => context.cleanReplyText(value);
  const request = '```json\ncurl --request POST https://example.com/api --data-raw \'{"user_id":"demo"}\'\n```';
  const response = '```json\n{"status_code":200,"data":{"certificates":[]}}\n```';
  const text = 'Request:\n' + request + '\n\nResponse:\n' + response;
  assert.equal(clean(text), text);
  assert.equal(clean('```json\n{"type":"customer","name":"demo"}\n```'), '```json\n{"type":"customer","name":"demo"}\n```');
  assert.equal(clean('Before\n```json\n{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}\n```\nAfter'), 'Before\n\nAfter');
});

test('knowledge API blocks render as escaped copyable code and normalize malformed fences', () => {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const context = vm.createContext({ URL });
  vm.runInContext(source.slice(source.indexOf('function escapeChatMarkdown'), source.indexOf('// Render Chart.js')), context);
  const standard = context.parseMarkdown('Request:\n```json\n{"status":200,"html":"<script>alert(1)</script>"}\n```\nResponse');
  assert.match(standard, /class="chat-code-block"/);
  assert.match(standard, /copyChatCodeBlock\(this\)/);
  assert.match(standard, /&lt;script&gt;/);
  assert.doesNotMatch(standard, /<script>/);
  assert.match(standard, /\n  &quot;status&quot;: 200/);
  assert.match(standard, /Response/);
  const malformed = context.parseMarkdown('`json\ncurl --request POST https://example.com/api\n` [2, 3]\nNext paragraph');
  assert.match(malformed, /<span>bash<\/span>/);
  assert.match(malformed, /curl --request POST/);
  assert.match(malformed, /Next paragraph/);
  assert.doesNotMatch(malformed, /`json/);
  assert.equal((malformed.match(/chat-code-block/g) || []).length, 1);
  assert.match(context.parseMarkdown('Use `POST` here'), /<code/);
});

test('copy code uses only the displayed code text', async () => {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  let copied;
  const context = vm.createContext({ navigator: { clipboard: { writeText: async text => { copied = text; } } }, setTimeout: () => {} });
  vm.runInContext(source.slice(source.indexOf('async function copyChatCodeBlock'), source.indexOf('function parseMarkdown(text)')), context);
  const button = { closest: () => ({ querySelector: () => ({ textContent: '{"status":200}' }) }) };
  await context.copyChatCodeBlock(button);
  assert.equal(copied, '{"status":200}');
  assert.ok(button.textContent);
});

test('decision model usage separates routing tokens without adding them to the request total', () => {
  const source = fs.readFileSync('src/frontend/js/modules/page_chat.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function escapeChatMarkdown'), source.indexOf('function sanitizeSystemPaths')) + source.slice(source.indexOf('function renderChatTokenUsage'), source.indexOf('async function copyPageChatQuestion')), context);
  const routing = { stages: [
    { model: 'tev1:4b', calls: 1, inputTokens: 323, outputTokens: 1, totalTokens: 324 },
    { model: 'tev1:4b', calls: 1, inputTokens: 100, outputTokens: 1, totalTokens: 101 },
    { model: '<chat-model>', calls: 1, inputTokens: 200, outputTokens: 5, totalTokens: 205 },
    { status: 'skipped', calls: 0 }
  ] };
  const html = context.renderChatTokenUsage({ available: true, inputTokens: 3903, outputTokens: 1111, totalTokens: 5014, byModel: routing.stages.filter(x => x.calls) }, routing);
  assert.match(html, /5\.014/);
  assert.match(html, /423/);
  assert.match(html, /425/);
  assert.match(html, /tev1:4b/);
  assert.match(html, /&lt;chat-model&gt;/);
  assert.doesNotMatch(html, /<chat-model>/);
  assert.match(html, /chat-routing-inline/);
  assert.doesNotMatch(html, /<details/);
  assert.ok(html.indexOf("chat-routing-inline") < html.indexOf("fa-arrow-down"));
  assert.equal(context.renderDecisionModelUsage({ stages: [{ calls: 0 }] }), '');
  assert.equal(context.renderDecisionModelUsage(null), '');
});
