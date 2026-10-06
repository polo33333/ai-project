const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('SQL copy preserves selection and highlighted viewport follows native textarea', async () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/frontend/js/modules/workflow_plugins.js'), 'utf8');
  const nodes = [];
  const node = () => { const value = { children: [], style: {}, dataset: {}, events: {}, classList: { add() {} }, setAttribute() {}, append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); }, insertBefore() {}, addEventListener(name, handler) { this.events[name] = handler; } }; nodes.push(value); return value; };
  let copied;
  const context = { document: { createElement: node, body: node() }, typeBadge: node, button(label, action) { const result = node(); result.textContent = label; result.onclick = action; return result; }, navigator: { clipboard: { async writeText(text) { copied = text; } } }, h: value => value, ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  let codeFieldId='), source.indexOf('  function field(')), context);
  const input = node(); Object.assign(input, { parentElement: node(), value: 'SELECT code FROM records', selectionStart: 7, selectionEnd: 11, clientWidth: 600, clientHeight: 180, scrollLeft: 30, scrollTop: 22, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
  context.codeField(input, 'sql');
  const copy = nodes.find(item => item.textContent === 'Sao chép');
  await copy.onclick(); assert.equal(copied, 'code'); assert.equal(input.selectionStart, 7); assert.equal(input.selectionEnd, 11);
  input.selectionEnd = input.selectionStart; await copy.onclick(); assert.equal(copied, input.value);
  const preview = nodes.find(item => item.className === 'wp-code-highlight');
  assert.equal(preview.style.width, '600px'); assert.equal(preview.style.height, '180px');
  input.scrollLeft = 90; input.events.scroll(); assert.equal(preview.scrollLeft, 90);
  assert.equal(input.events.paste, undefined); // Native paste retains browser cursor/selection and undo behavior.
});
