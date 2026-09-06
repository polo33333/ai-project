const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const retrievalService = require('../src/backend/knowledge_core/services/retrieval_service');
const datasetPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'retrieval_golden.sample.json'));
const limit = Math.max(1, Number(process.argv[3] || 5));

async function main() {
  const cases = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  let hits = 0;
  let reciprocalRank = 0;
  const details = [];
  for (const item of cases) {
    const { results, mode } = await retrievalService.search(item.query, { limit });
    const expected = new Set((item.expectedDocumentIds || []).map(String));
    const rank = results.findIndex(result => expected.has(String(result.payload?.documentId))) + 1;
    if (rank > 0) { hits++; reciprocalRank += 1 / rank; }
    details.push({ query: item.query, mode, rank: rank || null, returnedDocumentIds: results.map(result => result.payload?.documentId) });
  }
  const report = { dataset: datasetPath, cases: cases.length, limit, recallAtK: cases.length ? hits / cases.length : 0, mrr: cases.length ? reciprocalRank / cases.length : 0, details };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (cases.length && hits !== cases.length) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
