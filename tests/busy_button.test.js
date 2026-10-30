'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');

// Just enough DOM for busyButton: elements, text nodes, classes and attributes.
class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parent = null; }
  get textContent() { return this.data; }
  replaceWith(node) { this.parent.insert(node, this); this.parent.removeChild(this); }
}
class Element {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag; this.childNodes = []; this.parent = null; this.attributes = {}; this.disabled = false; this.className = '';
    const self = this;
    this.classList = { contains: name => self.className.split(' ').includes(name), add: name => { self.className = `${self.className} ${name}`.trim(); },
      remove: name => { self.className = self.className.split(' ').filter(item => item !== name).join(' '); } };
  }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this.append(value); }
  adopt(node) { const child = typeof node === 'string' ? new Text(node) : node; child.parent?.removeChild(child); child.parent = this; return child; }
  append(...nodes) { for (const node of nodes) this.childNodes.push(this.adopt(node)); }
  insert(node, before) { const child = this.adopt(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, child); }
  removeChild(node) { this.childNodes = this.childNodes.filter(item => item !== node); node.parent = null; }
  remove() { this.parent?.removeChild(this); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
}

test('a busy button shows a spinner, refuses a second click and comes back as it was', () => {
  const window = {};
  vm.runInContext(fs.readFileSync('src/frontend/shared/js/ui_dialogs.js', 'utf8'), vm.createContext({ window, document: { createElement: tag => new Element(tag), addEventListener() {} } }));
  const button = new Element('button'), icon = new Element('i'), label = new Element('span');
  label.append('Thêm Provider'); button.append(icon, ' ', label);

  const idle = window.busyButton(button, 'Đang lưu…');
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  const state = button.childNodes.at(-1);
  assert.equal(state.className, 'busy-button-state');
  assert.equal(state.textContent.trim(), 'Đang lưu…');
  assert.equal(window.busyButton(button, 'Đang lưu…'), null);

  // Code that relabels the button while it is busy keeps its change.
  label.textContent = 'Cập nhật Provider';
  idle();
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-busy'), null);
  assert.equal(button.classList.contains('is-busy'), false);
  assert.equal(button.textContent.trim(), 'Cập nhật Provider');

  // Without a label the button keeps its own words next to the spinner; a missing button is a no-op.
  const plain = new Element('button'); plain.append('Phát hành');
  const restore = window.busyButton(plain);
  assert.equal(plain.childNodes.at(-1).textContent.trim(), 'Phát hành');
  restore(); assert.equal(plain.textContent, 'Phát hành');
  assert.equal(typeof window.busyButton(null), 'function');
});
