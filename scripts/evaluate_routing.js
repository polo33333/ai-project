'use strict';
// Routing baseline: does a question reach the document library, the data path
// or conversation? Scores the deterministic part only (keyword gate of
// search_schema + document signal); the model's kind choice is measured by the
// "routing" group of the live eval. Read-only; calls only the local embedding model.
//   node scripts/evaluate_routing.js [fixture.json] [--threshold 0.6] [--out report.json]
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const storage = require('../src/backend/storage');
storage.loadEnvironment();
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : null; };
const datasetPath = path.resolve(args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'))
  || path.join(__dirname, '..', 'tests', 'fixtures', 'routing_golden.json'));

// What the v2 pipeline does before (and around) its single model call.
//   gate "general": conversation unless the signal is strong (then documents, no model call)
//   gate "data":    the model chooses; a strong signal turns a "chat" choice into documents
function decide({ gate, strong }) {
  if (gate !== 'data') return strong ? 'document' : 'chat';
  return strong ? 'model_or_document' : 'model';
}

function score(rows, threshold) {
  const strong = row => row.signal.reason === 'file_name' || row.signal.reason === 'explicit' || (row.signal.score ?? -1) >= threshold;
  const decided = rows.map(row => ({ ...row, strong: strong(row), outcome: decide({ gate: row.gate, strong: strong(row) }) }));
  const of = route => decided.filter(row => row.route === route);
  const share = (list, predicate) => list.length ? +(list.filter(predicate).length / list.length).toFixed(3) : null;
  const documents = of('document'), data = of('data'), chat = of('chat').filter(row => !(row.accept || []).includes('document'));
  return { threshold, rows: decided, summary: {
    // Documents: guaranteed (gate → documents), protected (model, but a chat choice is rescued), at the model's mercy, or lost.
    documentGuaranteed: share(documents, row => row.outcome === 'document'),
    documentProtected: share(documents, row => row.outcome === 'model_or_document'),
    documentModelOnly: share(documents, row => row.outcome === 'model'),
    documentLost: share(documents, row => row.outcome === 'chat'),
    // A data question is never moved by the signal at the model step; it is only wrong if the gate sends it to documents.
    dataToDocument: share(data, row => row.outcome === 'document'),
    dataConflicts: share(data, row => row.outcome === 'model_or_document'),
    // A conversation question with a strong signal would be answered from documents.
    chatToDocument: share(chat, row => row.strong) },
    misses: decided.filter(row => (row.route === 'document' && ['chat', 'model'].includes(row.outcome))
      || (row.route === 'data' && row.outcome === 'document') || (row.route === 'chat' && !(row.accept || []).includes('document') && row.strong))
      .map(row => ({ id: row.id, route: row.route, gate: row.gate, score: row.signal.score, reason: row.signal.reason, outcome: row.outcome })) };
}

// Before this plan: the gate alone decided, and nothing rescued a chat choice.
function before(rows) {
  const documents = rows.filter(row => row.route === 'document');
  return { documentLost: +(documents.filter(row => row.gate !== 'data').length / documents.length).toFixed(3),
    documentModelOnly: +(documents.filter(row => row.gate === 'data').length / documents.length).toFixed(3) };
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const { buildSchemaContext } = require('../src/backend/intelligent_core/schema_context_service');
  const { documentSignal } = require('../src/backend/knowledge_core/rag/signal');
  const rows = [];
  await documentSignal('khởi động');
  for (const item of fixture.cases) {
    const schema = await buildSchemaContext(item.query, {});
    const signal = await documentSignal(item.query, { threshold: 1 });
    rows.push({ id: item.id, category: item.category, route: item.route, accept: item.accept || [], query: item.query,
      gate: schema.mode === 'data' ? 'data' : 'general', signal });
  }
  const chosen = Number(option('threshold') || require('../src/backend/knowledge_core/rag/signal').minScore());
  const sweep = [0.5, 0.525, 0.55, 0.575, 0.6, 0.625, 0.65, 0.675, 0.7].map(threshold => ({ threshold, ...score(rows, threshold).summary }));
  const result = score(rows, chosen);
  const report = { generatedAt: new Date().toISOString(), dataset: path.relative(process.cwd(), datasetPath), fixtureStatus: fixture.status || null,
    cases: rows.length, before: before(rows), threshold: chosen, summary: result.summary, sweep, misses: result.misses, rows: result.rows };
  const out = path.resolve(option('out') || path.join(__dirname, '..', 'data', 'eval', 'routing', `${report.generatedAt.replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const pct = value => value === null ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`;
  const lines = [`before: documents lost at the gate ${pct(report.before.documentLost)}, left to the model ${pct(report.before.documentModelOnly)}`, '',
    'threshold  doc→doc  doc protected  doc model-only  doc lost  data→doc  data conflict  chat→doc'];
  for (const row of sweep) lines.push(`${row.threshold.toFixed(3).padEnd(9)}${row.threshold === chosen ? '*' : ' '} ${pct(row.documentGuaranteed)}  ${pct(row.documentProtected)}       ${pct(row.documentModelOnly)}        ${pct(row.documentLost)}  ${pct(row.dataToDocument)}  ${pct(row.dataConflicts)}       ${pct(row.chatToDocument)}`);
  lines.push('', `misses at ${chosen}:`, ...result.misses.map(miss => `  ${miss.id} [${miss.route}] gate=${miss.gate} score=${miss.score} → ${miss.outcome}`));
  process.stdout.write(`${lines.join('\n')}\n\nreport: ${out}\n`);
  if (fixture.status !== 'approved') process.stdout.write('note: routing set is a draft until its routes are reviewed\n');
}

(async () => {
  await storage.bootstrapStorage();
  try { await storage.run(main); } finally { await storage.close(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
