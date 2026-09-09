'use strict';

const { monitorEventLoopDelay } = require('node:perf_hooks');
const target = process.env.BENCHMARK_URL || 'http://127.0.0.1:3000/health/ready';
const levels = String(process.env.BENCHMARK_CONCURRENCY || '1,5,20').split(',').map(Number).filter(Number.isFinite);
const requestsPerLevel = Math.max(1, Number(process.env.BENCHMARK_REQUESTS || 50));

const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] || 0;
async function run(concurrency) {
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const durations = []; let errors = 0; let cursor = 0;
  async function worker() {
    while (cursor < requestsPerLevel) {
      cursor += 1; const started = performance.now();
      try { const response = await fetch(target); if (!response.ok) errors += 1; await response.arrayBuffer(); } catch (_) { errors += 1; }
      durations.push(performance.now() - started);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker)); delay.disable();
  return { concurrency, requests: durations.length, p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95), errorRate: errors / durations.length, eventLoopLagP95Ms: delay.percentile(95) / 1e6 };
}

(async () => {
  const results = [];
  for (const level of levels) results.push(await run(level));
  process.stdout.write(`${JSON.stringify({ target, timestamp: new Date().toISOString(), results }, null, 2)}\n`);
})().catch(error => { console.error(error); process.exitCode = 1; });
