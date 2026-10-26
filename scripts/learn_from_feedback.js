'use strict';

// Feedback learning loop (src/backend/training_core/feedback_loop.js).
//
//   node scripts/learn_from_feedback.js build [--days 60]
//   node scripts/learn_from_feedback.js approve <drafts.json>
//
// build writes artifacts/learning/feedback-<date>.json (git-ignored: real
// questions and replies). For each draft to keep set accept=true; edit
// example.contract when the drafted one is not right, and case.must from the
// source data (as for tests/fixtures/live_eval_cases.json). approve stores the
// accepted examples on the default SQL source (application store, never SQL
// Server; backup in data/backup/) and adds the accepted cases to the fixture.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const [command, file] = process.argv.slice(2).filter(value => !value.startsWith('--') && !/^\d+$/.test(value));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), list[index + 1]?.startsWith('--') ? true : list[index + 1] ?? true]] : pairs, []));
const fixturePath = path.join(root, 'tests/fixtures/live_eval_cases.json');
const learning = require(path.join(root, 'src/backend/training_core/feedback_loop'));

async function withStorage(action) {
  const storage = require(path.join(root, 'src/backend/storage'));
  storage.loadEnvironment();
  await storage.bootstrapStorage();
  try { return await storage.run(() => action(storage), { files: ['chat_history.json', 'chat_feedback.json', 'db_sources.json'] }); }
  finally { await storage.close(); }
}

(async () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (command === 'build') {
    const { parseTime } = require(path.join(root, 'src/backend/training_core/pipeline_metrics'));
    const since = Date.now() - (Number(args.days) || 60) * 86400000;
    const drafts = await withStorage(storage => {
      const history = storage.read('chat_history.json', []).filter(record => (parseTime(record.timestamp)?.getTime() || 0) >= since);
      const source = storage.read('db_sources.json', []).find(item => item.isDefault);
      return learning.draftItems(history, storage.read('chat_feedback.json', []), { existingCases: fixture.cases, examples: source?.learnedExamples || [] });
    });
    const outDir = path.join(root, 'artifacts/learning');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `feedback-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(out, JSON.stringify({ instructions: 'Set accept=true to keep a draft. example = question -> v2 contract offered to the planner; case.must = checks from source data.', drafts }, null, 2));
    console.log(JSON.stringify({ out: path.relative(root, out), drafts: drafts.length,
      corrections: drafts.filter(item => item.kind === 'correction').length, confirmed: drafts.filter(item => item.kind === 'confirmed').length,
      withExample: drafts.filter(item => item.example).length }, null, 2));
  } else if (command === 'approve' && file) {
    const { drafts = [] } = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const result = await withStorage(storage => {
      const validate = require(path.join(root, 'src/backend/agent_core/pipeline/contract_pipeline')).validateContract;
      const sources = storage.read('db_sources.json', []);
      const source = sources.find(item => item.isDefault);
      if (!source) throw new Error('No default SQL source');
      const promoted = learning.promoteLearning(drafts, { examples: source.learnedExamples || [], fixture, validateContract: validate });
      if (promoted.added.examples.length) {
        const backupDir = path.join(root, 'data/backup');
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, `learned_examples_before_${Date.now()}.json`), JSON.stringify({ sourceId: source.id, learnedExamples: source.learnedExamples || [] }, null, 2));
        storage.write('db_sources.json', sources.map(item => item.id === source.id ? { ...item, learnedExamples: promoted.examples } : item));
      }
      return promoted;
    });
    if (result.added.cases.length) fs.writeFileSync(fixturePath, `${JSON.stringify(result.fixture, null, 2)}\n`);
    console.log(JSON.stringify({ examples: result.added.examples, cases: result.added.cases, skipped: result.skipped }, null, 2));
  } else {
    console.error('Usage: node scripts/learn_from_feedback.js build [--days 60] | approve <drafts.json>');
    process.exitCode = 1;
  }
})().catch(error => { console.error('LEARNING_FAILED', error.message); process.exitCode = 1; });
