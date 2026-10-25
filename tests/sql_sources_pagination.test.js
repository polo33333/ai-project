'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('source pagination renders continuous row numbers, resets size and clamps after deletion', () => {
  const tbody = { rows: [], set innerHTML(value) { this.rows = []; this.html = value; }, appendChild(row) { this.rows.push(row); } };
  const pager = { innerHTML: '' };
  const context = vm.createContext({ window: {}, document: {
    getElementById(id) { return id === 'db-sources-tbody' ? tbody : id === 'sql-pagination' ? pager : null; },
    createElement() { return { style: {}, classList: { add() {} } }; }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/admin-client/js/modules/sql_connector.js'), 'utf8'), context);
  context.window.dbSourcesData = Array.from({ length: 23 }, (_, i) => ({ id: `id${i}`, dbName: `DB${i}` }));
  vm.runInContext('changeDbSourcesPage(2)', context);
  assert.equal(tbody.rows.length, 10);
  assert.match(tbody.rows[0].innerHTML, /sql-source-index">11</);
  assert.match(tbody.rows[9].innerHTML, /sql-source-index">20</);
  vm.runInContext('changeDbSourcesPage(3)', context);
  assert.equal(tbody.rows.length, 3);
  assert.match(tbody.rows[2].innerHTML, /sql-source-index">23</);
  context.window.dbSourcesData = context.window.dbSourcesData.slice(0, 11);
  vm.runInContext('renderDbSourcesTable()', context);
  assert.equal(context.window.dbSourcesPage, 2);
  assert.equal(tbody.rows.length, 1);
  vm.runInContext('changeDbSourcesPageSize(20)', context);
  assert.equal(context.window.dbSourcesPage, 1);
  assert.equal(tbody.rows.length, 11);
  context.window.dbSourcesData = [];
  vm.runInContext('renderDbSourcesTable()', context);
  assert.match(tbody.html, /colspan="8"/);
  assert.equal(context.window.dbSourcesPage, 1);
  assert.match(pager.innerHTML, /0–0/);
});
