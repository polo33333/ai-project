'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('dictionary overview graph only uses active verified relationships', () => {
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, console });
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8');
  vm.runInContext(source, context);
  window.tableRelationshipsData = [
    { id: 'verified', status: 'verified', isActive: true },
    { id: 'suggested', status: 'suggested', isActive: true },
    { id: 'rejected', status: 'rejected', isActive: true },
    { id: 'disabled', status: 'verified', isActive: false }
  ];
  assert.equal(vm.runInContext('getVerifiedDictionaryGraphRelationships().length', context), 1);
  assert.equal(vm.runInContext('getVerifiedDictionaryGraphRelationships()[0].id', context), 'verified');
});
