'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function parseInline(value) {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
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
    assert.doesNotMatch(require('../src/backend/assistant/security_guard').maskSensitiveData(path),/secret\.txt|admin|server/i);
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
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const start = source.indexOf('function stripInlineDownloadLink');
  const end = source.indexOf('\nfunction parseMarkdownInline', start);
  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end)}\nthis.result = stripInlineDownloadLink('Đã xuất file thành công: [Tải file tại đây](/api/exports/report.xlsx).', '/api/exports/report.xlsx');`, context);
  assert.equal(context.result, 'Đã xuất file thành công.');
});

test('multiple grouped exports retain their labels and counts without a duplicate fallback card', () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function escapeChatMarkdown'), source.indexOf('\nfunction splitMarkdownTableRow')), context);
  vm.runInContext(source.slice(source.indexOf('function renderPageChatDownloadAction'), source.indexOf('\nfunction typeThinkingText')), context);
  const reply = '- [Nam](/api/exports/men.xlsx) — 7 bản ghi\n- [Nữ](/api/exports/women.xlsx) — 2 bản ghi';
  context.reply = reply;
  assert.equal(vm.runInContext("stripInlineDownloadLink(reply, '/api/exports/men.xlsx')", context), reply);
  assert.equal(vm.runInContext("renderPageChatDownloadAction('/api/exports/men.xlsx', parseMarkdownInline(reply))", context), '');
  const card = vm.runInContext("renderPageChatDownloadAction('/api/exports/men.xlsx', '', {label:'Nam',summary:'7 bản ghi'})", context);
  assert.match(card, />Nam<\/span>/);
  assert.match(card, /7 bản ghi · Bảng tính · XLSX/);
  assert.match(card, /href="\/api\/exports\/men.xlsx"/);
});

test('modal and standalone embed renderers hide paths while retaining export links',()=>{
  const value='[Tải](/api/exports/report.xlsx) (file:///C:/Users/Admin/AppData/Local/Temp/report.xlsx)';
  const page=fs.readFileSync('src/frontend/shared/js/modules/page_chat.js','utf8');
  const app=fs.readFileSync('src/frontend/shared/js/app.js','utf8');
  const modal=vm.createContext({parseMarkdown:parseInline});
  vm.runInContext(page.slice(page.indexOf('function sanitizeSystemPaths'),page.indexOf('function parseMarkdownInline')),modal);
  vm.runInContext(app.slice(app.indexOf('function renderCopilotText'),app.indexOf('function renderCopilotDownloadAction')),modal);
  const modalHtml=vm.runInContext(`renderCopilotText(${JSON.stringify(value)})`,modal);
  const embed=fs.readFileSync('src/frontend/embed-client/knowledgehub-chat.js','utf8');
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
  const page = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const pageContext = vm.createContext({});
  const pageStart = page.indexOf('function isBooleanDisplayColumn');
  const pageEnd = page.indexOf('\nfunction renderMarkdownTable', pageStart);
  vm.runInContext(`${page.slice(pageStart, pageEnd)}\nthis.dateOnly=formatChatDisplayValue('2002-05-24T00:00:00.000Z');this.dateTime=formatChatDisplayValue('2026-09-20T14:30:45.000Z');this.yes=formatChatDisplayValue(1,'IsVAT');this.no=formatChatDisplayValue(false,'IsVAT');this.number=formatChatDisplayValue(0,'Quantity');`, pageContext);
  assert.equal(pageContext.dateOnly, '24/05/2002');
  assert.equal(pageContext.dateTime, '20/09/2026 14:30:45');
  assert.equal(pageContext.yes, 'Có');
  assert.equal(pageContext.no, 'Không');
  assert.equal(pageContext.number, '0');
  assert.equal(vm.runInContext("formatChatDisplayValue(6652704, 'Tiền hóa đơn (VNĐ)')", pageContext), '6.652.704 ₫');
  assert.equal(vm.runInContext("formatChatDisplayValue('001234', 'EmployeeID')", pageContext), '001234');
  assert.equal(vm.runInContext("formatChatDisplayValue(246, 'ID hợp đồng')", pageContext), '246');
  assert.equal(vm.runInContext("formatChatDisplayValue(1500000, 'Giá trị hợp đồng')", pageContext), '1.500.000');
  assert.equal(vm.runInContext("formatChatDisplayValue(1500000, 'Thành tiền (đồng)')", pageContext), '1.500.000 ₫');

  const embed = fs.readFileSync('src/frontend/embed-client/knowledgehub-chat.js', 'utf8');
  assert.match(embed, /formatDisplayValue\(row\[cellIndex\]/);
  assert.match(embed, /escapeHtml\(formatDisplayValue\(cell, data\.toolResult\.columns\[cellIndex\]\)\)/);
});

test('API examples survive reply cleaning while internal chart payloads are hidden', () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
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
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
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
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  let copied;
  const context = vm.createContext({ navigator: { clipboard: { writeText: async text => { copied = text; } } }, setTimeout: () => {} });
  vm.runInContext(source.slice(source.indexOf('async function copyChatCodeBlock'), source.indexOf('function parseMarkdown(text)')), context);
  const button = { closest: () => ({ querySelector: () => ({ textContent: '{"status":200}' }) }) };
  await context.copyChatCodeBlock(button);
  assert.equal(copied, '{"status":200}');
  assert.ok(button.textContent);
});

test('chat token badges show request totals without model breakdowns', () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const bodyClasses = new Set();
  const context = vm.createContext({ document: { body: { classList: { contains: name => bodyClasses.has(name) } } } });
  vm.runInContext(source.slice(source.indexOf('const isPageChatEmbedded'), source.indexOf('\nfunction pageChatProviderId')), context);
  vm.runInContext(source.slice(source.indexOf('function escapeChatMarkdown'), source.indexOf('function sanitizeSystemPaths')) + source.slice(source.indexOf('function renderChatTokenUsage'), source.indexOf('async function copyPageChatQuestion')), context);
  const routing = { stages: [
    { model: 'tev1:4b', calls: 1, inputTokens: 323, outputTokens: 1, totalTokens: 324 },
    { model: 'tev1:4b', calls: 1, inputTokens: 100, outputTokens: 1, totalTokens: 101 },
    { model: '<chat-model>', calls: 1, inputTokens: 200, outputTokens: 5, totalTokens: 205 },
    { status: 'skipped', calls: 0 }
  ] };
  const html = context.renderChatTokenUsage({ available: true, inputTokens: 3903, outputTokens: 1111, totalTokens: 5014, byModel: routing.stages.filter(x => x.calls) }, routing);
  assert.match(html, /5\.014/);
  assert.match(html, /3\.903/);
  assert.match(html, /1\.111/);
  assert.doesNotMatch(html, /423|425|tev1:4b|chat-model|chat-routing-inline/);
  assert.doesNotMatch(html, /<details/);
  assert.equal(context.renderChatTokenUsage(null), '');
  for (const mode of ['kh-chat-standalone', 'kh-chat-embedded']) {
    bodyClasses.add(mode);
    assert.equal(context.renderChatTokenUsage({ available: true, totalTokens: 5014 }), '');
    bodyClasses.delete(mode);
  }
});

test('answer rating sits in the action row and keeps the earlier choice', () => {
  const source = fs.readFileSync('src/frontend/shared/js/modules/page_chat.js', 'utf8');
  const context = vm.createContext({});
  const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  vm.runInContext(slice('function escapeChatMarkdown', 'function sanitizeSystemPaths') + slice('function renderPageChatActionIcon', 'function appendChatMessage')
    + slice('function renderInlineChatFeedback', 'function renderChatFeedback'), context);
  const feedback = { dataset: { auditId: 'run-1', providerId: 'p1', model: 'gemini' } };
  const html = context.renderInlineChatFeedback(feedback, 'dislike');
  assert.match(html, /class="chat-feedback-inline"[^>]*data-audit-id="run-1"[^>]*data-provider-id="p1"[^>]*data-model="gemini"/);
  assert.equal((html.match(/onclick="submitChatFeedback\(this\)"/g) || []).length, 2);
  assert.match(html, /data-rating="dislike" class="is-selected"/);
  assert.match(html, /data-rating="like" class=""/);
  assert.equal(context.renderInlineChatFeedback({ dataset: {} }), '', 'answers without a run cannot be rated');
  assert.equal(context.renderInlineChatFeedback(null), '');
});
