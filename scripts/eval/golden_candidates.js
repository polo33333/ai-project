'use strict';

// Builds labelling candidates for the live evaluation set from real chat
// turns, and promotes labelled ones into tests/fixtures/live_eval_cases.json.
//
//   node scripts/eval/golden_candidates.js build [--limit 120] [--per-group 15] [--days 60]
//   node scripts/eval/golden_candidates.js promote <candidates.json>
//
// build writes artifacts/golden/candidates-<date>.json (git-ignored: it holds
// real questions and replies). For each candidate to keep, set accept=true and
// write must / mustNot / mustTools from the source data, as for the existing
// cases (see the fixture's "scoring"). promote copies only those.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const [command, file] = process.argv.slice(2).filter(value => !value.startsWith('--') && !/^\d+$/.test(value));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), list[index + 1]?.startsWith('--') ? true : list[index + 1] ?? true]] : pairs, []));
const fixturePath = path.join(root, 'tests/fixtures/live_eval_cases.json');
const { selectCandidates, promote } = require(path.join(root, 'src/backend/training/golden_candidates'));

async function readStores(files) {
  const storage = require(path.join(root, 'src/backend/storage'));
  storage.loadEnvironment();
  if (!storage.enabled()) return files.map(name => JSON.parse(fs.readFileSync(path.join(root, 'data', name), 'utf8')));
  await storage.bootstrapStorage();
  try { return await storage.run(() => files.map(name => structuredClone(storage.read(name, []))), { files }); }
  finally { await storage.close(); }
}

(async () => {
  if (command === 'build') {
    const [history, feedback] = await readStores(['chat_history.json', 'chat_feedback.json']);
    const days = Number(args.days) || 60;
    const { parseTime } = require(path.join(root, 'src/backend/training/pipeline_metrics'));
    const since = Date.now() - days * 86400000;
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const candidates = selectCandidates(history.filter(record => (parseTime(record.timestamp)?.getTime() || 0) >= since), {
      existingCases: fixture.cases, feedback, limit: Number(args.limit) || 120, perGroup: Number(args['per-group']) || 15 });
    const outDir = path.join(root, 'artifacts', 'golden');
    fs.mkdirSync(outDir, { recursive: true });
    const now = new Date();
    const out = path.join(outDir, `candidates-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.json`);
    fs.writeFileSync(out, JSON.stringify({ instructions: 'Set accept=true and fill must/mustNot/mustTools from the source data (not from the observed reply), then run: node scripts/eval/golden_candidates.js promote <this file>. Scoring rules: tests/fixtures/live_eval_cases.json "scoring".',
      createdAt: now.toISOString(), source: { days, existingCases: fixture.cases.length }, candidates }, null, 2));
    const groups = candidates.reduce((counts, item) => ({ ...counts, [item.group]: (counts[item.group] || 0) + 1 }), {});
    console.log(JSON.stringify({ out: path.relative(root, out), candidates: candidates.length, groups }, null, 2));
  } else if (command === 'promote' && file) {
    const source = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const result = promote(fixture, source.candidates || source);
    if (result.added.length) fs.writeFileSync(fixturePath, `${JSON.stringify(result.fixture, null, 2)}\n`);
    console.log(JSON.stringify({ added: result.added, skipped: result.skipped, total: result.fixture.cases.length }, null, 2));
  } else {
    console.error('Usage: golden_candidates.js build [--limit 120] [--per-group 15] [--days 60] | promote <candidates.json>');
    process.exitCode = 2;
  }
})().catch(error => { console.error('GOLDEN_FAILED', error.message); process.exitCode = 1; });
