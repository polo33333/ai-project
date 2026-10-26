'use strict';
// Document retrieval baseline: recall@k / MRR per retrieval mode on the golden
// set. Read-only; calls only the local embedding model, never an answer model.
//   node scripts/evaluate_retrieval.js [fixture.json] [--modes a,b] [--out report.json] [--baseline old.json] [--rechunk]
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
const { scoreCase, summarize, validateFixture } = require('./eval/document_retrieval_scoring');
storage.loadEnvironment();

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : null; };
const datasetPath = path.resolve(args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'))
  || path.join(__dirname, '..', 'tests', 'fixtures', 'retrieval_golden.json'));
const LIMIT = 10;

// Each mode is one way the product retrieves today (or after the RAG upgrade).
const MODES = {
  // retrieval_service as core.js calls it, with the configured GraphRAG switch.
  hybrid: { env: {}, run: (rag, item) => rag.retrievalService.search(item.query, { limit: LIMIT }) },
  hybrid_nograph: { env: { GRAPHRAG_ENABLED: 'false' }, run: (rag, item) => rag.retrievalService.search(item.query, { limit: LIMIT }) },
  hybrid_graph: { env: { GRAPHRAG_ENABLED: 'true' }, run: (rag, item) => rag.retrievalService.search(item.query, { limit: LIMIT }) },
  lexical: { env: { EMBEDDING_ENABLED: 'false', GRAPHRAG_ENABLED: 'false' }, run: (rag, item) => rag.retrievalService.search(item.query, { limit: LIMIT }) },
  // The governed search_knowledge_base tool used by the v2 document answer (verbatim question).
  v2_tool: { env: {}, run: async (rag, item) => {
    const search = await require('../src/backend/intelligent_core/tool_registry')._searchKnowledgeBase({ query: item.query, limit: LIMIT });
    return { results: (search.result?.documents || []).map(document => ({ payload: { documentId: document.documentId,
      chunkIndex: document.chunkIndex, fullText: document.text } })) };
  } },
  // The shared RAG service: question understanding (prefix, follow-up, file name) then retrieval.
  pipeline: { env: {}, available: rag => Boolean(rag.ragService), run: (rag, item) => rag.ragService.retrieve({ question: item.query,
    previous: item.previous || null, limit: LIMIT }) }
};

// --rechunk: measure the current chunker before reindexing. The library files
// are chunked and embedded again in memory; Qdrant and the library are not written.
async function simulateRechunk() {
  const library = require('../src/backend/knowledge_core/services/library_service');
  const qdrant = require('../src/backend/services/qdrant_service');
  const structured = require('../src/backend/knowledge_core/services/structured_document');
  const corpus = new Map();
  for (const document of library.getDocuments()) {
    const parts = await structured.extract(fs.readFileSync(library.findDocument(document.id).storagePath), document.fileType);
    const chunks = structured.chunks(parts, library.chunkText.bind(library)).map(chunk => ({ ...chunk, revision: document.revision }));
    const vectors = [];
    for (let start = 0; start < chunks.length; start += 32) {
      vectors.push(...await qdrant.embedTexts(chunks.slice(start, start + 32).map(chunk => `${document.title}\n${chunk.text}`)));
    }
    corpus.set(String(document.id), chunks.map((chunk, index) => ({ chunk, vector: vectors[index], title: document.title })));
  }
  const cosine = (a, b) => { let dot = 0, na = 0, nb = 0; a.forEach((value, i) => { dot += value * b[i]; na += value * value; nb += b[i] * b[i]; }); return dot / Math.sqrt(na * nb || 1); };
  library.getChunks = id => (corpus.get(String(id)) || []).map(item => item.chunk);
  qdrant.searchDocuments = async (query, limit = 6, { documentIds = [], detailed = false } = {}) => {
    const [vector] = await qdrant.embedTexts([query]);
    const results = documentIds.flatMap(id => (corpus.get(String(id)) || []).map(item => ({ score: cosine(vector, item.vector),
      payload: { ...item.chunk, documentId: String(id), title: item.title, fullText: item.chunk.text } })))
      .sort((a, b) => b.score - a.score).slice(0, limit);
    return detailed ? { results, status: 'ok', errorCode: null } : results;
  };
  return [...corpus.values()].reduce((sum, items) => sum + items.length, 0);
}

async function runMode(name, cases, rag) {
  const mode = MODES[name];
  const saved = Object.fromEntries(Object.keys(mode.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, mode.env);
  const rows = [], latencies = [];
  try {
    for (const item of cases) {
      const started = Date.now();
      const retrieval = await mode.run(rag, item);
      latencies.push(Date.now() - started);
      rows.push({ ...scoreCase(item, retrieval.results || []), retrievalMode: retrieval.mode || null });
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return { mode: name, ...summarize(rows), latencyMs: { p50: sorted[Math.floor(sorted.length / 2)], p90: sorted[Math.ceil(sorted.length * 0.9) - 1] }, rows };
}

const pct = value => value === null || value === undefined ? '   -  ' : `${(value * 100).toFixed(1).padStart(5)}%`;
function table(report, baseline) {
  const lines = ['mode            recall@1 recall@5   MRR@10  docHit@1  p50ms  misses'];
  for (const result of report.modes) {
    const o = result.overall;
    lines.push(`${result.mode.padEnd(15)} ${pct(o.recallAt1)}  ${pct(o.recallAt5)}  ${pct(o.mrrAt10)}  ${pct(o.documentHitAt1)}  ${String(result.latencyMs.p50).padStart(5)}  ${result.misses.length}`);
    const before = baseline?.modes?.find(item => item.mode === result.mode)?.overall;
    if (before) lines.push(`  vs baseline   ${['recallAt1', 'recallAt5', 'mrrAt10', 'documentHitAt1'].map(metric => `${metric} ${((o[metric] - before[metric]) * 100).toFixed(1)}`).join('  ')}`);
  }
  const categories = [...new Set(report.modes.flatMap(result => Object.keys(result.byCategory)))].filter(category => category !== 'no_answer');
  lines.push('', `recall@5 by category: ${categories.join(' | ')}`);
  for (const result of report.modes) lines.push(`${result.mode.padEnd(15)} ${categories.map(category => pct(result.byCategory[category]?.recallAt5)).join(' ')}`);
  return lines.join('\n');
}

async function main() {
  const fixture = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  const cases = validateFixture(fixture);
  const rag = { retrievalService: require('../src/backend/knowledge_core/services/retrieval_service') };
  try { rag.ragService = require('../src/backend/knowledge_core/rag'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const requested = (option('modes') || 'hybrid,hybrid_nograph,lexical,v2_tool,pipeline').split(',').map(name => name.trim()).filter(Boolean);
  const unknown = requested.filter(name => !MODES[name]);
  if (unknown.length) throw new Error(`Unknown mode: ${unknown.join(', ')}`);
  const modes = [];
  const rechunkedChunks = args.includes('--rechunk') ? await simulateRechunk() : null;
  // Warm the embedding model so the first case does not carry the load time.
  await rag.retrievalService.search('khởi động', { limit: 1 });
  for (const name of requested) {
    if (MODES[name].available && !MODES[name].available(rag)) continue;
    modes.push(await runMode(name, cases, rag));
  }
  const report = { generatedAt: new Date().toISOString(), dataset: path.relative(process.cwd(), datasetPath), fixtureStatus: fixture.status || null,
    cases: cases.length, limit: LIMIT, rechunkedChunks, config: { graphRagEnabled: process.env.GRAPHRAG_ENABLED || 'true', rerankerEnabled: process.env.RERANKER_ENABLED || 'false',
      embeddingEnabled: process.env.EMBEDDING_ENABLED !== 'false', candidateLimit: Number(process.env.RETRIEVAL_CANDIDATE_LIMIT || 30) }, modes };
  const out = path.resolve(option('out') || path.join(__dirname, '..', 'data', 'eval', 'retrieval', `${report.generatedAt.replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const baseline = option('baseline') ? JSON.parse(fs.readFileSync(path.resolve(option('baseline')), 'utf8')) : null;
  process.stdout.write(`${table(report, baseline)}\n\nreport: ${out}\n`);
  if (fixture.status !== 'approved') process.stdout.write('note: golden set is a draft until its answers are reviewed\n');
}

(async () => {
  await storage.bootstrapStorage();
  try { await storage.run(main); } finally { await storage.close(); }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
