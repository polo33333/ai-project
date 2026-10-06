'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/chat_tool_ui.js'), 'utf8');
function component() { const context = vm.createContext({ Intl }); vm.runInContext(source, context); return context.ChatToolUI; }

test('shared tools UI handles empty data, both API name formats, zero rows and zero duration', () => {
  const ui = component();
  assert.equal(ui.render(null), ''); assert.equal(ui.render([]), ''); assert.equal(ui.render([null]), '');
  const html = ui.render([{ toolName: 'search_schema', success: true, rowCount: 0, durationMs: 0 }]);
  assert.match(html, /Tìm cấu trúc dữ liệu/); assert.match(html, /0 dòng/); assert.match(html, /0 ms/);
  assert.match(html, /Thành công/); assert.match(html, /1 bước/);
  assert.match(ui.render([{ name: 'render_chart', durationMs: 1250 }]), /1,3 giây/);
});

test('shared tools UI escapes names and complete error messages in main, popup and vector embed variants', () => {
  const ui = component(); const calls = [{ name: '<img src=x onerror=alert(1)>', success: false, error: '<script>alert(1)</script> & "error"' }];
  for (const options of [{}, { vectorIcons: true }]) {
    const html = ui.render(calls, options);
    assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;script&gt;/);
    assert.match(html, /Không thành công/); assert.match(html, /1 lỗi/);
    assert.match(html, /&amp; &quot;error&quot;/);
    if (options.vectorIcons) assert.match(html, /<svg/);
  }
  assert.doesNotMatch(ui.render([{ name: 'tool', rowCount: -1, durationMs: -2 }]), /-1 dòng|-2 ms/);
});
