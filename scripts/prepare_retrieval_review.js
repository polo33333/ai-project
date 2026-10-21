'use strict';
// Migrate reviewed-intent history into UNAPPROVED E3 drafts. Never run workflows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { evaluate } = require('./eval/retrieval_measurement');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function prepare(corpus, source) {
  const index = new Map();
  for (const label of source.labels) {
    if (index.has(label.question)) throw new Error('HISTORY_LABEL_DUPLICATE_QUERY');
    index.set(label.question, label);
  }
  const labels = [], skipped = [];
  for (const item of corpus.cases) {
    const expected = index.get(item.question);
    if (!expected || !['chat', 'workflow'].includes(expected.route) || (expected.route === 'workflow' && !expected.workflowId)) {
      skipped.push(item.id); continue;
    }
    const groupId = hash(['history-session', item.sessionId || item.id]);
    labels.push({ caseId: `E3:${item.id}`, block: 'E3', groupId,
      languageGroup: null, split: parseInt(groupId.slice(0, 2), 16) % 5 === 0 ? 'holdout' : 'dev',
      query: item.question, sourceScope: `historical-workflow-catalog:${hash(corpus.definitions)}`,
      expectedIds: expected.route === 'workflow' ? [expected.workflowId] : [],
      expectedDisposition: expected.route === 'workflow' ? 'retrieve' : 'no_match', reviewer: null, approvedAt: null });
  }
  const input = { schemaVersion: '1', snapshot: { sourceRevision: hash(corpus), modelRevision: 'not-collected',
    configRevision: 'not-collected', principalRef: `historical-owner:${hash(corpus.owner || null)}` },
    policy: { minLabelsPerBlock: 50, k: 5, margin: 0.02, alpha: 0.05 }, labels, observations: [] };
  evaluate(input);
  return { input, summary: { draftLabels: labels.length, skipped: skipped.length,
    independentGroups: new Set(labels.map(label => label.groupId)).size,
    dev: labels.filter(label => label.split === 'dev').length, holdout: labels.filter(label => label.split === 'holdout').length,
    approved: 0, warning: 'Draft mapping of chat to no_match requires review; original labels lack reviewer/date/language group. No observations imported.' } };
}
if (require.main === module) {
  try {
    const [corpusPath, labelsPath, outputPath] = process.argv.slice(2);
    if (!outputPath) throw new Error('Usage: node scripts/prepare_retrieval_review.js <history-corpus.json> <history-labels.json> <draft.private.json>');
    const prepared = prepare(JSON.parse(fs.readFileSync(corpusPath, 'utf8')), JSON.parse(fs.readFileSync(labelsPath, 'utf8')));
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(prepared.input, null, 2)}\n`);
    console.log(JSON.stringify(prepared.summary, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
