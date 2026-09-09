'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('dictionary validates and persists table defaults', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kh-dictionary-'));
  fs.writeFileSync(path.join(directory, 'dictionary.json'), JSON.stringify([{ tableName: 'Metrics', columns: [
    { columnName: 'Value', dataType: 'decimal' }, { columnName: 'OccurredAt', dataType: 'datetime' }, { columnName: 'Label', dataType: 'nvarchar' }
  ] }]));
  const script = `const d=require('./src/backend/services/dictionary_service');d.syncToQdrant=async()=>({success:true});(async()=>{await d.updateTableMetadata('Metrics',{defaultMetric:'Value',defaultTimeColumn:'OccurredAt',defaultAggregation:'AVG'});try{await d.updateTableMetadata('Metrics',{defaultMetric:'Label'});process.exit(2)}catch(e){if(e.statusCode!==400)throw e}})().catch(e=>{console.error(e);process.exit(1)})`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, KNOWLEDGEHUB_DATA_DIR: directory }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(fs.readFileSync(path.join(directory, 'dictionary.json'), 'utf8'))[0];
  assert.deepEqual([table.defaultMetric, table.defaultTimeColumn, table.defaultAggregation], ['Value', 'OccurredAt', 'AVG']);
  fs.rmSync(directory, { recursive: true, force: true });
});
