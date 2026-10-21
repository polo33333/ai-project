'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

test('live catalog preserves composite keys, excludes INCLUDE columns and does not duplicate FK pairs', async () => {
  const keys = JSON.stringify([
    { name: 'PK_AB', isPrimaryKey: true, columns: [{ columnName: 'A' }, { columnName: 'B' }] },
    { name: 'UX_C', columns: [{ columnName: 'C' }] },
    { name: 'UX_Filtered', hasFilter: true, columns: [{ columnName: 'D' }] },
    { name: 'UX_Disabled', isDisabled: true, columns: [{ columnName: 'E' }] }
  ]);
  let query;
  class Request extends EventEmitter {
    constructor(sql, callback) { super(); query = sql; this.callback = callback; }
  }
  class Connection extends EventEmitter {
    connect() { this.emit('connect'); }
    close() {}
    execSql(request) {
      for (const [index, columnName] of ['A', 'B', 'C', 'D', 'E', 'Included'].entries()) {
        const row = { TABLE_SCHEMA: 'dbo', TABLE_NAME: 'Example', COLUMN_NAME: columnName,
          DATA_TYPE: 'int', ORDINAL_POSITION: index + 1, UNIQUE_CONSTRAINTS: keys,
          ...(index < 2 ? { FK_NAME: 'FK_AB', REF_SCHEMA: 'dbo', REF_TABLE: 'Parent',
            REF_COLUMN: columnName, FK_ORDINAL: index + 1 } : {}) };
        request.emit('row', Object.entries(row).map(([colName, value]) => ({ metadata: { colName }, value })));
      }
      request.callback(null);
    }
  }
  const filename = path.resolve('src/backend/services/sql_connector.js');
  const actualRequire = createRequire(filename);
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, process,
    AbortSignal, AbortController,
    require: name => name === 'tedious' ? { Connection, Request } : actualRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const tables = JSON.parse(JSON.stringify(await context.module.exports.queryLiveInformationSchema({ dbName: 'ERP' })));
  const table = tables[0];
  assert.deepEqual(table.uniqueConstraints[0].columnNames, ['A', 'B']);
  assert.deepEqual(table.columns.filter(c => c.isPrimaryKey).map(c => c.columnName), ['A', 'B']);
  assert.deepEqual(table.columns.filter(c => c.isUnique).map(c => c.columnName), ['C']);
  assert.deepEqual(table.foreignKeys[0].columnPairs.map(p => p.sourceColumn), ['A', 'B']);
  assert.match(query, /ic\.key_ordinal>0 AND ic\.is_included_column=0/);
  assert.doesNotMatch(query, /\) uq ON/);
});
