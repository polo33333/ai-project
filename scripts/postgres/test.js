'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test', 'tests/postgres_storage.test.js', 'tests/postgres_runtime.test.js'], {
  cwd: path.resolve(__dirname, '../..'), stdio: 'inherit', env: { ...process.env, KNOWLEDGEHUB_TEST_POSTGRES: '1' }
});
process.exitCode = result.status ?? 1;
