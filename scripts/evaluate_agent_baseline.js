'use strict';

// Offline regression evidence only; never a substitute for approved business labels.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const suites = [
  'embedding_mode', 'comparison_presentation', 'request_contract', 'entity_list_query',
  'memory_resolution', 'governed_read_only', 'governed_controller',
  'answer_envelope', 'governance_policy', 'governed_tool_foundation',
  'governed_artifacts_audit', 'tool_result', 'request_execution_budget', 'knowledge_prompt_policy',
  'sql_security_corpus', 'durable_memory',
  'tool_registry', 'mcp_service', 'automation_api_full', 'retrieval_measurement',
  'agent_operations', 'agent_release', 'document_tool_contract', 'channel_contract_rendering'
].map(name => `tests/${name}.test.js`);
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
};
const started = Date.now();
const outputDir = path.join(root, 'artifacts', 'agent-baseline', new Date().toISOString().replaceAll(':', '-'));
fs.mkdirSync(outputDir, { recursive: true });
const tests = spawnSync(process.execPath, [
  '--require', './tests/helpers/setup_isolated_data.js', '--test', '--test-reporter=tap', ...suites
], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, KNOWLEDGEHUB_TEST_USE_INSTANCE_DATA: '', APP_STORAGE_BACKEND: 'json' } });
const log = `${tests.stdout || ''}${tests.stderr || ''}`;
fs.writeFileSync(path.join(outputDir, 'tests.tap'), log);
const count = name => Number(log.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] || 0);
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [name, count(name)]));
const diff = git(['diff', 'HEAD', '--', 'src', 'scripts', 'tests', 'package.json', 'package-lock.json']);
const status = git(['status', '--porcelain']);
const snapshot = crypto.createHash('sha256');
for (const directory of ['src', 'scripts', 'tests']) {
  const base = path.join(root, directory);
  for (const file of fs.readdirSync(base, { recursive: true }).sort()) {
    const absolute = path.join(base, file);
    if (!fs.statSync(absolute).isFile()) continue;
    snapshot.update(`${directory}/${file.split(path.sep).join('/')}\0`);
    snapshot.update(fs.readFileSync(absolute));
  }
}
const report = {
  reportVersion: '1', kind: 'offline_technical_regression',
  startedAt: new Date(started).toISOString(), durationMs: Date.now() - started,
  runtime: { node: process.version, platform: process.platform },
  revision: { head: git(['rev-parse', 'HEAD']), dirty: Boolean(status),
    sourceSnapshotSha256: snapshot.digest('hex'),
    trackedDiffSha256: diff === null ? null : crypto.createHash('sha256').update(diff).digest('hex'),
    suiteHashes: Object.fromEntries(suites.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])) },
  configuration: { storage: 'isolated-json', embedding: 'both-modes-tested-with-stubs', provider: 'offline-test-dispatch' },
  counts, passed: tests.status === 0 && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0,
  exitCode: tests.status, error: tests.error?.code || null, suites,
  businessAcceptance: 'pending_owner_review_and_real_source_labels',
  measured: { liveModelQuality: null, retrievalRecall: null, modelTokenUsage: null, liveLatencyP50: null, liveLatencyP95: null },
  limitations: ['Test runtime is not live request latency.', 'Offline test success does not establish ON/OFF quality equivalence.',
    'Business review cases do not contain fabricated SQL records or approved retrieval IDs.']
};
fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, outputDir }, null, 2));
process.exitCode = report.passed ? 0 : 1;
