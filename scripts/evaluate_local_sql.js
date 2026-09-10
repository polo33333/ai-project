'use strict';

const fs = require('fs');
const path = require('path');
const evaluator = require('./eval/semantic_sql_evaluator');

function readArgs(argv) {
  const args = { mode: 'validate', repetitions: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--live') args.mode = 'live';
    else if (value === '--validate') args.mode = 'validate';
    else if (value.startsWith('--')) args[value.slice(2)] = argv[++i];
  }
  args.repetitions = Math.max(1, Number(args.repetitions || 1));
  return args;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertEvalDataDirectory(projectRoot) {
  const dataDir = process.env.KNOWLEDGEHUB_DATA_DIR;
  if (!dataDir) throw new Error('Live eval requires KNOWLEDGEHUB_DATA_DIR');
  const resolved = path.resolve(dataDir);
  if (resolved === path.resolve(projectRoot, 'data')) throw new Error('Live eval refuses to use the project data directory');
  const markerFile = path.join(resolved, 'eval_fixture_marker.json');
  const marker = loadJson(markerFile);
  if (marker.kind !== 'knowledgehub-local-sql-eval') throw new Error('Invalid eval_fixture_marker.json');
}

async function runLive(corpus, args, projectRoot) {
  assertEvalDataDirectory(projectRoot);
  const providerId = args.provider || process.env.LOCAL_SQL_EVAL_PROVIDER_ID;
  const dbSourceId = args.db || process.env.LOCAL_SQL_EVAL_DB_SOURCE_ID;
  if (!providerId || !dbSourceId) throw new Error('Live eval requires --provider and --db (or matching environment variables)');
  const core = require('../src/backend/intelligent_core/core');
  const evaluations = [];

  for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
    for (const testCase of corpus.cases.filter(item => item.live !== false)) {
      const result = await core.chat(testCase.question, {
        providerId,
        dbSourceId,
        sessionId: `semantic-eval-${testCase.id}-${repetition}`,
        permissions: ['*'],
        webSearch: false,
        knowledgeSearchEnabled: false
      });
      evaluations.push({ ...evaluator.evaluateCase(testCase, result), repetition });
    }
  }
  return { mode: 'live', corpus: corpus.name, ...evaluator.summarize(evaluations), evaluations };
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const projectRoot = path.resolve(__dirname, '..');
  const corpusFile = path.resolve(args.corpus || path.join(projectRoot, 'tests/fixtures/local_sql_golden.json'));
  const corpus = loadJson(corpusFile);
  const validation = evaluator.validateCorpus(corpus);
  if (!validation.valid) throw new Error(`Invalid corpus:\n${validation.errors.join('\n')}`);

  const report = args.mode === 'live'
    ? await runLive(corpus, args, projectRoot)
    : {
        mode: 'validate', corpus: corpus.name, cases: corpus.cases.length,
        categories: Object.fromEntries(Object.entries(Object.groupBy
          ? Object.groupBy(corpus.cases, item => item.category || 'uncategorized')
          : corpus.cases.reduce((acc, item) => { (acc[item.category || 'uncategorized'] ||= []).push(item); return acc; }, {}))
          .map(([key, values]) => [key, values.length])),
        valid: true
      };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.output) fs.writeFileSync(path.resolve(args.output), text);
  else process.stdout.write(text);
  if (report.failed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
