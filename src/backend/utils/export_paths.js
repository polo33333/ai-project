'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '../../..');

function getExportsDirectory() {
  if (process.env.KNOWLEDGEHUB_EXPORT_DIR) {
    return path.resolve(process.env.KNOWLEDGEHUB_EXPORT_DIR);
  }
  if (process.env.KNOWLEDGEHUB_DATA_DIR) {
    return path.resolve(process.env.KNOWLEDGEHUB_DATA_DIR, 'exports');
  }
  return path.join(root, 'data', 'exports');
}

module.exports = { getExportsDirectory };
