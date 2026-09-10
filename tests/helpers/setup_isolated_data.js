'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.KNOWLEDGEHUB_TEST_USE_INSTANCE_DATA) {
  const fixtureDir = path.resolve(__dirname, '..', 'fixtures');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledgehub-test-'));
  fs.copyFileSync(path.join(fixtureDir, 'dictionary_seed.sample.json'), path.join(dataDir, 'dictionary.json'));
  fs.copyFileSync(path.join(fixtureDir, 'domain_aliases.sample.json'), path.join(dataDir, 'domain_aliases.json'));
  fs.copyFileSync(path.join(fixtureDir, 'ai_providers.sample.json'), path.join(dataDir, 'ai_providers.json'));
  fs.writeFileSync(path.join(dataDir, 'table_relationships.json'), '[]\n', 'utf8');
  process.env.KNOWLEDGEHUB_DATA_DIR = dataDir;
  process.env.KNOWLEDGEHUB_EXPORT_DIR = path.join(dataDir, 'exports');
}
