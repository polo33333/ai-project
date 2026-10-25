'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function modalFactory() {
  const source = fs.readFileSync('src/frontend/shared/js/modules/workflow_plugins.js', 'utf8');
  const start = source.indexOf('  function modal(');
  const end = source.indexOf('  async function aiConnectionDialog(', start);
  const document = {
    body: { appendChild() {} },
    createElement() {
      const parts = new Map([['header button', {}], ['.workflow-editor-body', {}], ['footer', {}]]);
      return { removed: false, querySelector: selector => parts.get(selector), remove() { this.removed = true; } };
    }
  };
  return vm.runInNewContext(source.slice(start, end) + '; modal;', { document, h: value => value });
}

test('AI connection popup stays open on backdrop clicks and retains entered content until explicitly closed', () => {
  const modal = modalFactory();
  const dialog = modal('AI', { closeOnBackdrop: false });
  dialog.body.value = 'unsaved host and token';
  dialog.backdrop.onclick({ target: dialog.body });
  dialog.backdrop.onclick({ target: dialog.backdrop });
  assert.equal(dialog.backdrop.removed, false);
  assert.equal(dialog.body.value, 'unsaved host and token');
  dialog.backdrop.querySelector('header button').onclick();
  assert.equal(dialog.backdrop.removed, true);
});

test('existing workflow dialogs retain their backdrop dismissal behavior', () => {
  const dialog = modalFactory()('Existing dialog');
  dialog.backdrop.onclick({ target: dialog.body });
  assert.equal(dialog.backdrop.removed, false);
  dialog.backdrop.onclick({ target: dialog.backdrop });
  assert.equal(dialog.backdrop.removed, true);
});
