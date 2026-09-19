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

test('SQL cards count only enabled tables belonging to the default database', () => {
  const context = analyticsContext();
  const elements = Object.fromEntries(['val-connectors', 'val-connectors-detail', 'val-tables', 'val-tables-detail'].map(id => [id, {}]));
  context.document = { getElementById: id => elements[id] };
  context.sources = [{ id: 'a', dbName: 'Main', isDefault: true }, { id: 'b', dbName: 'Other' }];
  context.dictionary = [
    { dbSourceId: 'a', isActive: true },
    { dbSourceId: 'a', isActive: false },
    { dbName: 'Main', isActive: true },
    { dbSourceId: 'b', dbName: 'Main', isActive: true }
  ];
  vm.runInContext('renderDashboardSqlMetrics(sources, dictionary)', context);
  assert.equal(elements['val-connectors'].textContent, 'Main');
  assert.equal(elements['val-tables'].textContent, '2');
  assert.equal(elements['val-tables-detail'].textContent, 'Main · 3 bảng đã nạp');
  vm.runInContext('sources[0].isDefault = false; sources[1].isDefault = true; renderDashboardSqlMetrics(sources, dictionary)', context);
  assert.equal(elements['val-connectors'].textContent, 'Other');
  assert.equal(elements['val-tables'].textContent, '1');
  vm.runInContext('renderDashboardSqlMetrics([], dictionary)', context);
  assert.equal(elements['val-tables'].textContent, '0');
});

test('report period filters use Vietnam month and year boundaries', () => {
  const context = analyticsContext();
  context.history = [
    { timestamp: '2025-12-31T16:59:59Z' },
    { timestamp: '2025-12-31T17:00:00Z' },
    { timestamp: '23:59:59 31/1/2026' },
    { timestamp: '00:00:00 1/2/2026' },
    { timestamp: 'invalid' }
  ];
  assert.equal(vm.runInContext('filterAnalyticsPeriod(history, 2026, 1).length', context), 2);
  assert.equal(vm.runInContext('filterAnalyticsPeriod(history, 2026).length', context), 3);
  assert.equal(vm.runInContext('filterAnalyticsPeriod(history, 2024).length', context), 0);
});

test('report buckets cover leap months and selected historical years with matching costs', () => {
  const context = analyticsContext();
  context.history = [
    { timestamp: '12:00:00 29/2/2024', requestPayload: { providerId: 'cloud', tokenUsage: { totalTokens: 1000000 } } },
    { timestamp: '12:00:00 1/3/2024', requestPayload: { providerId: 'cloud', tokenUsage: { totalTokens: 2000000 } } },
    { timestamp: '12:00:00 1/3/2025' }
  ];
  context.providers = [{ id: 'cloud', apiFormat: 'openai', tokenCost: 0.005 }];
  const days = vm.runInContext('groupAnalyticsPeriod(history, providers, 2024, 2)', context);
  assert.equal(days.length, 29);
  assert.equal(days[28].queries, 1);
  assert.equal(days[28].estimatedCost, 5);
  const months = vm.runInContext('groupAnalyticsPeriod(history, providers, 2024)', context);
  assert.equal(months.length, 12);
  assert.equal(months.reduce((sum, bucket) => sum + bucket.queries, 0), 2);
  assert.equal(months.reduce((sum, bucket) => sum + bucket.estimatedCost, 0), 15);
});

test('changing the report period updates KPIs and preserves the dashboard totals', () => {
  const context = analyticsContext();
  const elements = Object.fromEntries([
    'analytics-year', 'analytics-month', 'analytics-total-cost', 'analytics-total-queries',
    'analytics-avg-latency', 'analytics-chart-period', 'val-queries'
  ].map(id => [id, { value: '', textContent: '', innerHTML: '' }]));
  elements['val-queries'].textContent = '99';
  context.document = { getElementById: id => elements[id] || null };
  context.data = { history: [
    { timestamp: '12:00:00 1/1/2024', latencyMs: 100, requestPayload: { providerId: 'cloud', tokenUsage: { totalTokens: 1000 } } },
    { timestamp: '12:00:00 1/2/2024', latencyMs: 300 }
  ], providers: [{ id: 'cloud', tokenCost: 5 }] };
  vm.runInContext('window.pageAnalyticsYear = 2024; window.pageAnalyticsMonth = 1; renderPageAnalytics(data)', context);
  assert.equal(elements['analytics-total-queries'].textContent, '1');
  assert.equal(elements['analytics-total-cost'].textContent, '$5.00');
  assert.equal(elements['analytics-avg-latency'].textContent, '100');
  elements['analytics-year'].value = '2024';
  elements['analytics-month'].value = '3';
  vm.runInContext('changePageAnalyticsPeriod()', context);
  assert.equal(elements['analytics-total-queries'].textContent, '0');
  assert.equal(elements['analytics-total-cost'].textContent, '$0.00');
  assert.equal(elements['analytics-avg-latency'].textContent, '0');
  assert.equal(elements['val-queries'].textContent, '99');
});

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
