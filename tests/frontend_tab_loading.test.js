const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '../src/frontend/js', file), 'utf8');

test('initial shell includes the real dashboard and logs without another template request', async () => {
  const html = require('../src/backend/services/dashboard_shell').render(fs.readFileSync(path.join(__dirname, '../src/frontend/index.html'), 'utf8'));
  for (const id of ['analyticsChart', 'dashboardFeedbackChart', 'dashboard-activity-card', 'dash-router-primary', 'view-dashboard-logs']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.ok(!html.includes('dashboard-startup-loading'));
  const container = { dataset: { loaded: 'true' }, querySelector: () => ({}) };
  const context = { Map, document: { getElementById: () => container }, fetch: () => { throw new Error('Unexpected template request'); } };
  vm.createContext(context); vm.runInContext(read('core/view_loader.js'), context);
  await context.loadViewComponents('overview');
});

test('a stalled dashboard template aborts, releases its request, and can be retried', async () => {
  let calls = 0;
  const controllers = [];
  const container = { dataset: {} };
  const context = { Map, document: { getElementById: () => container },
    AbortSignal: { timeout(ms) {
      assert.equal(ms, 10000);
      const controller = new AbortController(); controllers.push(controller); return controller.signal;
    } },
    fetch: async (url, { signal }) => {
      assert.equal(url, '/views/dashboard.html');
      if (++calls === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      return { ok: true, text: async () => '<section>Dashboard</section>' };
    }
  };
  vm.createContext(context); vm.runInContext(read('core/view_loader.js'), context);
  const first = context.loadDashboardView();
  const second = context.loadDashboardView();
  assert.equal(calls, 1);
  const rejected = Promise.all([assert.rejects(first, /timeout/), assert.rejects(second, /timeout/)]);
  controllers[0].abort(new Error('template timeout'));
  await rejected;
  await context.loadDashboardView();
  assert.equal(calls, 2);
  assert.equal(container.dataset.loaded, 'true');
  assert.match(container.innerHTML, /Dashboard/);
});

test('architecture suggestion reuses dashboard data without fetching sources or Qdrant again', async () => {
  const nodes = Object.fromEntries(['ai-suggestion-banner', 'banner-title', 'banner-text', 'banner-action-btn'].map(id => [id, {}]));
  const source = read('app.js');
  const start = source.indexOf('async function refreshArchitectureSuggestion(');
  const end = source.indexOf('\nfunction ', start);
  const context = { window: {}, document: { getElementById: id => nodes[id] },
    sessionStorage: { getItem: () => null }, fetch: () => { throw new Error('Unexpected duplicate request'); } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  await context.refreshArchitectureSuggestion({ sources: [{ id: 'source-1' }], qdrant: { connected: true, pointsCount: 10 } });
  assert.equal(nodes['ai-suggestion-banner'].hidden, true);
  assert.equal(context.window.architectureSuggestionAction, null);
});

test('main and popup model lists share one request, including an empty result', async () => {
  const source = read('modules/ai_providers.js');
  let resolve, calls = 0;
  const context = { window: {}, Date, fetch: () => { calls++; return new Promise(done => { resolve = done; }); } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('window.aiProvidersData'), source.indexOf('function getProviderFormat')), context);
  const first = context.window.loadChatProviders();
  const second = context.window.loadChatProviders();
  assert.equal(calls, 1);
  resolve({ ok: true, json: async () => ({ providers: [] }) });
  await Promise.all([first, second]);
  await context.window.loadChatProviders();
  assert.equal(calls, 1, 'An empty catalog is cached too');
});

test('default quick prompts stay hidden despite cached or persona data and share the preload request', async () => {
  const source = read('modules/page_chat.js');
  let resolve, calls = 0;
  const container = { children: [], replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); } };
  const cached = [{ label: 'Cached', prompt: 'cached question' }];
  const context = { window: { aiPersona: { quickPrompts: cached } }, Date, sessionStorage: { getItem: () => JSON.stringify({ at: Date.now(), prompts: cached }), setItem() {} },
    document: { getElementById: () => container, createElement: () => ({ setAttribute() {}, append(...children) { this.children = children; } }), createTextNode: text => text },
    useQuickPrompt() {}, fetch: () => { calls++; return new Promise(done => { resolve = done; }); } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let quickPromptsRequest'), source.indexOf('// Exports')), context);
  const first = context.fetchAndRenderQuickPrompts();
  assert.equal(container.children.length, 0);
  assert.equal(container.hidden, true);
  const second = context.fetchAndRenderQuickPrompts();
  assert.equal(calls, 1);
  resolve({ ok: true, json: async () => ({ quickPrompts: cached }) });
  await Promise.all([first, second]);
  assert.equal(container.children.length, 0, 'Persona defaults never appear after refresh');
  assert.equal(container.hidden, true);
});

test('only latest model reply suggestions appear in staggered order and clear on the next user turn', () => {
  const source = read('modules/page_chat.js');
  const container = { children: [], replaceChildren() { this.children = []; }, appendChild(node) { this.children.push(node); } };
  const session = { id: 'chat-1', messages: [{ role: 'assistant', followUpSuggestions: [
    { speaker: 'user', label: 'Theo tháng', prompt: 'Thống kê theo tháng' },
    { speaker: 'assistant', label: 'Ignore', prompt: 'Ignore' },
    { speaker: 'user', label: 'Theo quý', prompt: 'Thống kê theo quý' }
  ] }] };
  let clicked;
  const context = { window: { chatSessions: [session], currentChatSessionId: session.id },
    document: { getElementById: () => container, createTextNode: text => text,
      createElement: () => ({ properties: {}, style: { setProperty(key,value) { this[key] = value; } },
        setAttribute() {}, append(...children) { this.children = children; } }) },
    useQuickPrompt: text => { clicked = text; } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let quickPromptsRequest'), source.indexOf('// Exports')), context);
  context.renderQuickPrompts();
  assert.equal(container.hidden, false);
  assert.equal(container.children.length, 2);
  assert.equal(container.children[1].style['--suggestion-order'], 1);
  const first = container.children[0];
  context.renderQuickPrompts();
  assert.equal(container.children[0], first, 'Identical rerenders do not restart the animation');
  first.onclick();
  assert.equal(clicked, 'Thống kê theo tháng');
  session.messages.push({ role: 'user', content: 'Theo tháng' });
  context.renderQuickPrompts();
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
  context.window.currentChatSessionId = 'empty';
  context.renderQuickPrompts();
  assert.equal(container.hidden, true);
});

test('table loading coalesces requests and clears busy state after failure', async () => {
  let reject, calls = 0;
  const classes = new Set();
  const attributes = new Map();
  const panel = {
    classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute: (k, v) => attributes.set(k, v), removeAttribute: k => attributes.delete(k),
    appendChild: node => { panel.overlay = node; }, closest: () => panel
  };
  const window = { fetchChatHistory: () => { calls++; return new Promise((_, no) => { reject = no; }); } };
  vm.runInNewContext(read('tab_loading.js'), { window, document: {
    querySelectorAll: selector => selector === '#chat-history-tbody' ? [panel] : [],
    createElement: () => ({ setAttribute() {}, remove() { panel.overlay = null; } })
  } });
  const first = window.fetchChatHistory();
  assert.equal(first, window.fetchChatHistory());
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.match(panel.overlay.innerHTML, /tab-skeleton/);
  assert.doesNotMatch(panel.overlay.innerHTML, /tab-data-spinner/);
  await Promise.resolve();
  assert.equal(calls, 1);
  reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(attributes.has('aria-busy'), false);
  assert.equal(panel.overlay, null);
  const retry = window.fetchChatHistory();
  await Promise.resolve();
  assert.equal(calls, 2);
  reject(new Error('offline'));
  await assert.rejects(retry);
});

test('tab cache keeps separate loaders, coalesces and retries failures', async () => {
  const source = read('core/tab_data.js');
  const start = source.indexOf('const TAB_DATA_CACHE_TTL_MS');
  const end = source.length;
  const context = { window: {}, normalizeMainTabKey: key => key, Date, Map, Promise };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  let calls = 0;
  const loader = async () => { calls++; };
  await Promise.all([context.loadTabData('chat', [loader]), context.loadTabData('chat', [loader])]);
  await context.loadTabData('chat', [loader]);
  assert.equal(calls, 1);
  await context.loadTabData('chat', [async () => { calls++; }]);
  assert.equal(calls, 2);
  context.window.invalidateMainTabData('chat');
  await context.loadTabData('chat', [loader]);
  assert.equal(calls, 3);
  let attempts = 0;
  const failing = async () => { if (++attempts === 1) throw new Error('offline'); };
  await assert.rejects(context.loadTabData('chat', [failing]));
  await context.loadTabData('chat', [failing]);
  assert.equal(attempts, 2);
});

test('concurrent view navigation fetches and inserts the HTML once', async () => {
  const source = read('core/view_loader.js');
  const start = source.indexOf('const viewLoadPromises');
  const end = source.length;
  let calls = 0, inserts = 0, resolve;
  const container = { querySelector: () => null, appendChild: () => { inserts++; } };
  const context = { Map, console, document: {
    getElementById: () => container,
    createElement: () => ({ content: { firstElementChild: { dataset: {} } } })
  }, fetch: () => { calls++; return new Promise(done => { resolve = done; }); } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const first = context.loadViewComponents('sql');
  const second = context.loadViewComponents('sql_connector');
  assert.equal(calls, 1);
  resolve({ ok: true, text: async () => '<div></div>' });
  await Promise.all([first, second]);
  assert.equal(inserts, 1);
});


test('different refresh parameters run in order and do not lose the newer request', async () => {
  const calls = [], finishes = [];
  const window = { fetchChatHistory: value => { calls.push(value); return new Promise(done => finishes.push(done)); } };
  vm.runInNewContext(read('tab_loading.js'), { window, document: { querySelectorAll: () => [] } });
  const first = window.fetchChatHistory('old');
  const second = window.fetchChatHistory('new');
  assert.equal(second, window.fetchChatHistory('new'));
  await Promise.resolve();
  assert.deepEqual(calls, ['old']);
  finishes.shift()(); await first;
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, ['old', 'new']);
  finishes.shift()(); await second;
});

test('explicit loader failure is retried and SQL writes invalidate dependent screens', async () => {
  const context = { window: {}, normalizeMainTabKey: key => key, Date, Map, Promise };
  vm.createContext(context); vm.runInContext(read('core/tab_data.js'), context);
  let attempts = 0; const loader = async () => ++attempts > 1;
  await assert.rejects(context.loadTabData('sql', [loader]));
  await context.loadTabData('sql', [loader]);
  let calls = 0; const dependent = async () => { calls++; };
  await context.loadTabData('dictionary', [dependent]);
  context.window.invalidateRelatedTabData('sql');
  await context.loadTabData('dictionary', [dependent]);
  assert.equal(calls, 2);
});

test('failed HTML load rejects, releases the pending slot, and can be retried', async () => {
  let calls = 0, inserts = 0;
  const container = { querySelector: () => null, appendChild: () => inserts++ };
  const context = { Map, console: { error() {} }, document: { getElementById: () => container,
    createElement: () => ({ content: { firstElementChild: { dataset: {} } } }) },
    fetch: async () => ({ ok: ++calls > 1, status: 503, text: async () => '<div></div>' }) };
  vm.createContext(context); vm.runInContext(read('core/view_loader.js'), context);
  await assert.rejects(context.loadViewComponents('sql'), /503/);
  await context.loadViewComponents('sql');
  assert.equal(calls, 2); assert.equal(inserts, 1);
});


test('returning to a previous filter after a queued refresh keeps the latest selection', async () => {
  const calls = [], finishes = [];
  const window = { fetchChatHistory: value => { calls.push(value); return new Promise(done => finishes.push(done)); } };
  vm.runInNewContext(read('tab_loading.js'), { window, document: { querySelectorAll: () => [] } });
  const a = window.fetchChatHistory('A'), b = window.fetchChatHistory('B'), latest = window.fetchChatHistory('A');
  assert.notEqual(a, latest);
  for (const request of [a, b, latest]) { await Promise.resolve(); finishes.shift()(); await request; }
  assert.deepEqual(calls, ['A', 'B', 'A']);
});

test('shared loading panel remains busy until both independent loaders finish', async () => {
  const attributes = new Map(); let removed = 0; const finishes = [];
  const panel = { closest() { return panel; }, classList: { add() {}, remove() {} },
    setAttribute: (key,value) => attributes.set(key,value), removeAttribute: key => attributes.delete(key), appendChild() {} };
  const window = { fetchApiKeys: () => new Promise(done => finishes.push(done)), fetchEmbedConfigs: () => new Promise(done => finishes.push(done)) };
  vm.runInNewContext(read('tab_loading.js'), { window, document: {
    querySelectorAll: selector => ['#api-keys-tbody','#embed-config-list'].includes(selector) ? [panel] : [],
    createElement: () => ({ setAttribute() {}, remove() { removed++; } }) } });
  const first = window.fetchApiKeys(), second = window.fetchEmbedConfigs(); await Promise.resolve();
  finishes[0](); await first; assert.equal(attributes.get('aria-busy'), 'true'); assert.equal(removed, 0);
  finishes[1](); await second; assert.equal(attributes.has('aria-busy'), false); assert.equal(removed, 1);
});


test('initial HTML loading does not invent six cards for SQL or other tab layouts', () => {
  const window = {};
  vm.runInNewContext(read('tab_loading.js'), { window });
  for (const key of ['sql','dictionary','data_governance','settings','analytics','library']) {
    const markup = window.tabViewSkeletonMarkup(key);
    assert.match(markup, /tab-view-progress/);
    assert.doesNotMatch(markup, /tab-skeleton-cards|tab-skeleton-row/);
  }
  assert.match(window.tabViewSkeletonMarkup('workflows'), /workflow-skeleton-grid/);
});


test('Training Core coalesces refreshes and clears per-section loading after a failed request', async () => {
  let reject, calls=0; const nodes={};
  for(const id of ['training-summary','training-cases']) nodes[id]={attributes:new Map(),setAttribute(k,v){this.attributes.set(k,v);},removeAttribute(k){this.attributes.delete(k);},replaceChildren(){this.innerHTML='';}};
  const source=read('modules/training_core.js');const window={};
  vm.runInNewContext(source.slice(0,source.indexOf('window.refreshTrainingView')), {window, document:{getElementById:id=>nodes[id]},fetch:()=>{calls++;return new Promise((_,no)=>{reject=no;});},renderTrainingReport(){}});
  const first=window.fetchTrainingReport(); assert.equal(first,window.fetchTrainingReport());assert.equal(calls,1);
  assert.match(nodes['training-summary'].innerHTML,/training-skeleton-number/);assert.match(nodes['training-cases'].innerHTML,/training-skeleton-case/);
  reject(new Error('offline'));assert.equal(await first,false);
  assert.equal(window.trainingReportPending,null);assert.equal(nodes['training-cases'].attributes.has('aria-busy'),false);assert.equal(nodes['training-summary'].innerHTML,'');
});
