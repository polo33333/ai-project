'use strict';

// Read-only catalog access and real inference. Never executes SQL business queries/workflows.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
require('../src/backend/storage/postgres/config').loadEnvironment();
const tev1 = require('../src/backend/automation/tev1_decision');
const { callOllamaDecision } = require('../src/backend/intelligent_core/adapters/ollama_decision');
const endpoint = process.env.CHAT_ROUTING_LOCAL_BASE_URL || 'http://127.0.0.1:11434';
const provider = { baseUrl: endpoint.replace(/\/+$/, ''), model: process.env.CHAT_ROUTING_LOCAL_MODEL || 'tev1:4b' };
const levels = (process.env.TEV1_CONCURRENCY || '1,4,8,11,15,20').split(',').map(Number);
const seconds = Number(process.env.TEV1_DURATION_SECONDS || 60);
const timeout = Number(process.env.CHAT_ROUTING_TIMEOUT_MS || 60000);
const sla = Number(process.env.TEV1_P95_TARGET_MS || 5000);
if (!levels.every(n => Number.isSafeInteger(n) && n > 0 && n <= 100) || ![seconds, timeout, sla].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid benchmark parameters');
const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;
function gpu() {
  try { return execFileSync('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim(); }
  catch { return null; }
}
async function main() {
  // Fail before database access if the actual model service is unavailable.
  const ps = await fetch(`${provider.baseUrl}/api/ps`, { signal: AbortSignal.timeout(5000) });
  if (!ps.ok) throw new Error(`Model preflight HTTP ${ps.status}`);
  const modelBefore = await ps.json();
  let definitions;
  if (process.env.TEV1_CATALOG_FILE) definitions = JSON.parse(fs.readFileSync(process.env.TEV1_CATALOG_FILE, 'utf8'));
  else {
    const { createPool } = require('../src/backend/storage/postgres/pool');
    const pool = createPool({ runtime: true });
    try {
      const records = (await pool.query('SELECT document FROM app.workflow_catalog')).rows.map(r => r.document);
      definitions = records.filter(r => r.enabled && r.published).flatMap(r => r.published.templates
        .filter(t => t.enabled !== false && !r.deletedTemplates?.[t.id]).map(t => ({ ...t, id: `${r.id}/${t.id}` })));
    } finally { await pool.end(); }
  }
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('Empty catalog');
  const questions = ['chi tiết sản lượng điện', 'thông tin chi tiết hợp đồng', 'thông tin chi tiết nv', 'danh sách toàn bộ hợp đồng', 'hợp đồng là gì?'];
  const prepared = questions.map(q => tev1.buildTask(q, definitions, null));
  // Includes greeting probe when enabled, as real routing does for non-greetings.
  const probe = String(process.env.CHAT_QUICK_GREETING_ENABLED ?? 'true').toLowerCase() === 'true';
  async function infer(index) {
    const i = index % questions.length;
    const signal = AbortSignal.timeout(timeout);
    if (probe) await callOllamaDecision(provider, tev1.buildGreetingTask(questions[i]).task, signal);
    const response = await callOllamaDecision(provider, prepared[i].task, signal);
    const converted = tev1.convertAnswers(JSON.parse(response.content), prepared[i], questions[i], null, {
      minProbability: Number(process.env.CHAT_ROUTING_MIN_PROBABILITY || .65), minMargin: Number(process.env.CHAT_ROUTING_MIN_MARGIN || .15)
    });
    return { route: converted.decision.route, tokens: response.usage.totalTokens };
  }
  const startCold = performance.now();
  await infer(0);
  const report = { timestamp: new Date().toISOString(), endpoint, model: provider.model,
    hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramGiB: os.totalmem()/2**30, gpu: gpu() },
    catalogSource: process.env.TEV1_CATALOG_FILE || 'live PostgreSQL catalog', catalogSize: definitions.length,
    quickGreetingProbe: probe, initialRequestMs: performance.now()-startCold, modelBefore,
    p95TargetMs: sla, timeoutMs: timeout, workload: 'closed-loop non-greeting routing; no think time; no chat model/SQL execution', results: [] };
  for (const concurrency of levels) {
    const started = performance.now(), deadline = started + seconds*1000;
    let cursor = 0;
    const requests = [], samples = [{ atMs: 0, gpu: gpu() }];
    const timer = setInterval(() => samples.push({ atMs: performance.now()-started, gpu: gpu() }), 5000);
    try {
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (performance.now() < deadline) {
          const index = cursor++, begin = performance.now();
          try { const outcome = await infer(index);
            requests.push({ ms: performance.now()-begin, ...outcome, ok: true });
          } catch (e) { requests.push({ ms: performance.now()-begin, ok: false, error: e.code || e.name }); }
        }
      }));
    } finally { clearInterval(timer); }
    const elapsedSeconds = (performance.now()-started)/1000;
    const success = requests.filter(r => r.ok), latencies = requests.map(r => r.ms);
    const result = { concurrency, elapsedSeconds, requests: requests.length, successful: success.length,
      successfulRps: success.length/elapsedSeconds, errorRate: 1-success.length/requests.length,
      p50Ms: percentile(latencies,.5), p95Ms: percentile(latencies,.95), p99Ms: percentile(latencies,.99),
      unclearRate: success.length ? success.filter(r => r.route === 'unclear').length/success.length : null,
      gpuSamples: samples, errors: requests.filter(r => !r.ok).map(r => r.error) };
    result.meetsTarget = result.errorRate <= .01 && result.p95Ms <= sla && result.successful >= 100;
    report.results.push(result);
    fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../artifacts/tev1-load-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...result, gpuSamples: undefined, errors: undefined }));
    if (result.errorRate > .1) { console.log('Stopping ramp: error rate exceeds 10%.'); break; }
  }
}
main().catch(e => { console.error(`TEV1 benchmark unavailable: ${e.code || e.message}`); process.exitCode = 1; });
