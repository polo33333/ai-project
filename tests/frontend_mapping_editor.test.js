const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('mapping cards preserve metadata and null relations while editing labels', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/workflow_plugins.js'), 'utf8');
  const inputs = [];
  const node = () => ({ children: [], append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); }, prepend() {}, setAttribute() {}, addEventListener() {}, remove() {} });
  const context = { document: { createElement: node }, icon: node, button: node,
    field(container, label, value) { const input = { value: String(value ?? ''), addEventListener() {} }; inputs.push({ label, input }); return input; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function resultMappingEditor('), source.indexOf('  function valueEditor(')), context);
  const original = [{ key: 'RefID', label: 'Tên liên kết', tableId: 'source::db::dbo::records', columnName: 'RefID', relationId: null, extra: { preserved: true } }];
  const read = context.resultMappingEditor(node(), original);
  assert.equal(JSON.stringify(read()), JSON.stringify(original));
  inputs.find(item => item.label === 'Tên hiển thị').input.value = 'Tên mới';
  assert.equal(read()[0].label, 'Tên mới');
  assert.equal(read()[0].relationId, null);
  assert.deepEqual(read()[0].extra, original[0].extra);
  assert.equal(original[0].label, 'Tên liên kết');
});
