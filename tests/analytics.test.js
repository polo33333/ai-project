'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function analyticsContext() {
  const context = vm.createContext({ window: {}, Intl, Date, console });
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/analytics.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

test('analytics accepts Vietnamese audit timestamps with and without comma', () => {
  const context = analyticsContext();
  const values = vm.runInContext(`[
    parseViTimestamp('19:29:32 3/9/2026'),
    parseViTimestamp('19:29:32, 3/9/2026')
  ].map(value => value && vietnamDayKey(value))`, context);
  assert.deepEqual(Array.from(values), ['2026-09-03', '2026-09-03']);
});

test('seven-day analytics counts current audit records instead of dropping them', () => {
  const context = analyticsContext();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date()).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const timestamp = `12:00:00 ${today.day}/${today.month}/${today.year}`;
  context.sampleHistory = [
    { timestamp, status: 'SUCCESS', latencyMs: 100, providerName: 'Ollama Local', requestPayload: { providerId: 'local' } },
    { timestamp, status: 'ERROR', latencyMs: 200, providerName: 'Google Gemini', requestPayload: { providerId: 'cloud' } }
  ];
  context.sampleProviders = [
    { id: 'local', name: 'Ollama Local', apiFormat: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    { id: 'cloud', name: 'Google Gemini', apiFormat: 'gemini', baseUrl: 'https://example.com' }
  ];
  const lastBucket = vm.runInContext('groupHistoryByDay(sampleHistory, 7, sampleProviders).at(-1)', context);
  assert.equal(lastBucket.queries, 2);
  assert.equal(lastBucket.localQueries, 1);
  assert.equal(lastBucket.thirdPartyQueries, 1);
  assert.equal(lastBucket.errors, 1);
});

test('monthly analytics separates local and third-party calls and attributes provider cost', () => {
  const context = analyticsContext();
  const nowParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: 'numeric', day: 'numeric'
  }).formatToParts(new Date()).reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const timestamp = `12:00:00 ${nowParts.day}/${nowParts.month}/${nowParts.year}`;
  context.monthHistory = [
    { timestamp, providerName: 'Ollama Local', requestPayload: { providerId: 'local', tokenUsage: { totalTokens: 1000 } } },
    { timestamp, providerName: 'Cloud API', requestPayload: { providerId: 'cloud', tokenUsage: { totalTokens: 2000 } } }
  ];
  context.monthProviders = [
    { id: 'local', apiFormat: 'ollama', tokenCost: 0 },
    { id: 'cloud', apiFormat: 'openai', baseUrl: 'https://example.com', tokenCost: 0.01 }
  ];
  const bucket = vm.runInContext('groupHistoryByMonth(monthHistory, 6, monthProviders).at(-1)', context);
  assert.equal(bucket.localQueries, 1);
  assert.equal(bucket.thirdPartyQueries, 1);
  assert.equal(bucket.queries, 2);
  assert.equal(bucket.estimatedCost, 0.02);
});
