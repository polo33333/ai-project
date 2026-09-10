'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getExportsDirectory } = require('../src/backend/utils/export_paths');

test('exports follow the isolated KnowledgeHub data directory', t => {
  const previousDataDir = process.env.KNOWLEDGEHUB_DATA_DIR;
  const previousExportDir = process.env.KNOWLEDGEHUB_EXPORT_DIR;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.KNOWLEDGEHUB_DATA_DIR;
    else process.env.KNOWLEDGEHUB_DATA_DIR = previousDataDir;
    if (previousExportDir === undefined) delete process.env.KNOWLEDGEHUB_EXPORT_DIR;
    else process.env.KNOWLEDGEHUB_EXPORT_DIR = previousExportDir;
  });
  delete process.env.KNOWLEDGEHUB_EXPORT_DIR;
  process.env.KNOWLEDGEHUB_DATA_DIR = path.join('tmp', 'isolated-eval');
  assert.equal(getExportsDirectory(), path.resolve('tmp', 'isolated-eval', 'exports'));
});

test('explicit export directory overrides the data directory', t => {
  const previous = process.env.KNOWLEDGEHUB_EXPORT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.KNOWLEDGEHUB_EXPORT_DIR;
    else process.env.KNOWLEDGEHUB_EXPORT_DIR = previous;
  });
  process.env.KNOWLEDGEHUB_EXPORT_DIR = path.join('tmp', 'exports-only');
  assert.equal(getExportsDirectory(), path.resolve('tmp', 'exports-only'));
});
