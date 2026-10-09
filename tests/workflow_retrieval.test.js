'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowRetrieval, configuration, identity } = require('../src/backend/automation/workflow_retrieval');
const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
function fixture(t, { count = 100, topK = 3, existing = true } = {}) {
  const env = { CHAT_ROUTING_RETRIEVAL_MODE: 'on', CHAT_ROUTING_RETRIEVAL_METHOD: 'hybrid', CHAT_ROUTING_RETRIEVAL_TOP_K: String(topK),
    EMBEDDING_MODEL: 'test-embed', QDRANT_DOCUMENT_VECTOR_SIZE: '2', EMBEDDING_PROVIDER: 'ollama', EMBEDDING_FALLBACK_MODE: 'deterministic' };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const definitions = Array.from({ length: count }, (_, index) => ({ id: `p/w${String(index).padStart(3, '0')}`,
    name: `Operation ${index}`, description: `Read entity ${index}`, examples: [], routingScope: 'targeted', inputs: {}, definitionHash: `hash${index}` }));
  const config = { ...configuration(), modelDigest: 'digest1' };
  const points = new Map(existing ? definitions.map(item => { const key = identity(item, config); return [key.id, { id: key.id, payload: { hash: key.hash }, vector: [1, 0] }]; }) : []);
  const calls = [];
  const state = { points, calls, definitions, digest: 'digest1', brokenEmbedding: false, ties: false, inject: false };
  const service = new WorkflowRetrieval({ fetchImpl: async (url, options = {}) => {
    const body = options.body && JSON.parse(options.body); calls.push({ url, body, method: options.method });
    const reply = value => ({ ok: true, status: 200, json: async () => value });
    if (url.endsWith('/api/tags')) return reply({ models: [{ name: 'test-embed', digest: state.digest }] });
    if (url.endsWith('/api/embed')) return reply({ embeddings: body.input.map(() => state.brokenEmbedding ? [0, 0] : [1, 0]) });
    if (url.endsWith('/points/search')) {
      assert.deepEqual(new Set(body.filter.must[0].has_id), new Set(definitions.map(item => identity(item, { ...config, modelDigest: state.digest }).id)));
      const result = body.filter.must[0].has_id.slice(0, body.limit).map((id, index) => ({ ...points.get(id), score: state.ties ? 0.9 : 0.99 - index * 0.1 }));
      if (state.inject) result.unshift({ id: 'unauthorized-point', payload: { workflowId: 'secret' }, score: 1 });
      return reply({ result });
    }
    if (url.includes('/points?')) { for (const point of body.points) points.set(point.id, point); return reply({ result: { status: 'completed' } }); }
    if (url.endsWith('/points')) return reply({ result: body.ids.map(id => points.get(id)).filter(Boolean) });
    return reply({ result: { config: { params: { vectors: { size: 2, distance: 'Cosine' } } } } });
  } });
  state.search = (question = 'Operation 0', current = null, options = {}) => service.search(question, definitions, current,
    { routingMode: 'auto', executionBudget: new RequestExecutionBudget({ maxModelCalls: 12 }), ...options });
  state.service = service;
  return state;
}
test('100 authorized workflows become a small hybrid shortlist and restored vectors are reused', async t => {
  const f = fixture(t); f.inject = true;
  const result = await f.search();
  assert.equal(result.definitions.length, 3);
  assert.equal(result.definitions[0].id, f.definitions[0].id);
  assert.equal(result.trace.catalogCount, 100);
  assert.ok(result.trace.evaluations < 10);
  const embedCalls = f.calls.filter(call => call.url.endsWith('/api/embed'));
  assert.equal(embedCalls.length, 1); assert.deepEqual(embedCalls[0].body.input, ['Operation 0']);
  assert.ok(!result.definitions.some(item => item.id === 'secret'));
});
test('query embedding cache never skips current ACL filtering', async t => {
  const f = fixture(t);
  await f.search(); f.definitions.splice(0, 1); await f.search();
  assert.equal(f.calls.filter(call => call.url.endsWith('/api/embed')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/points/search')).length, 2);
});
test('missing cards never embed or write during chat; explicit indexing makes them ready', async t => {
  const f = fixture(t, { count: 3, existing: false });
  await assert.rejects(f.search(), { code: 'ROUTING_RETRIEVAL_INDEX_STALE' });
  assert.equal(f.calls.filter(call => call.url.endsWith('/api/embed') || call.method === 'PUT').length, 0);
  await f.service.sync(f.definitions, configuration(), AbortSignal.timeout(1000));
  await f.search(); await f.search();
  assert.equal(f.calls.filter(call => call.url.includes('/points?')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/api/embed')).length, 2);
});
test('embedding model digest change creates new point identities and invalidates query cache', async t => {
  const f = fixture(t, { count: 3 });
  await f.search(); f.digest = 'digest2';
  await assert.rejects(f.search(), { code: 'ROUTING_RETRIEVAL_INDEX_STALE' });
  await f.service.sync(f.definitions, configuration(), AbortSignal.timeout(1000));
  await f.search();
  assert.equal(f.calls.filter(call => call.url.endsWith('/api/embed')).length, 3);
  assert.equal(f.points.size, 6);
});
test('strict embedding rejects zero vectors even when global deterministic fallback is enabled', async t => {
  const f = fixture(t); f.brokenEmbedding = true;
  await assert.rejects(f.search(), { code: 'ROUTING_RETRIEVAL_INVALID_VECTOR' });
});
test('authorized pending workflow is retained even outside vector shortlist', async t => {
  const f = fixture(t);
  const pending = f.definitions[99];
  const result = await f.search('Operation 0', { id: 'run', templateId: pending.id, missing: [], invalid: [], input: {}, definition: pending });
  assert.ok(result.definitions.some(item => item.id === pending.id));
});
test('packing rejects evaluation overflow instead of dropping input or competitors', async t => {
  const f = fixture(t);
  await assert.rejects(f.search('Operation 0', null, { executionBudget: new RequestExecutionBudget({ maxModelCalls: 3 }) }), { code: 'ROUTING_CONTEXT_EXCEEDED' });
});
test('a tied competitor beyond topK causes fallback rather than arbitrary selection', async t => {
  const f = fixture(t); f.ties = true;
  await assert.rejects(f.search('unknown'), { code: 'ROUTING_RETRIEVAL_COMPETING_CANDIDATES' });
});
test('chat_model shortlist does not require TEV1 budget', async t => {
  const f = fixture(t);
  const result = await f.search('Operation 0', null, { routingMode: 'chat_model', executionBudget: new RequestExecutionBudget({ maxModelCalls: 1 }) });
  assert.equal(result.trace.evaluations, 0);
});
test('caller cancellation aborts retrieval', async t => {
  const f = fixture(t);
  const controller = new AbortController(); controller.abort();
  t.mock.method(f.service, 'fetch', async (_, options) => { options.signal.throwIfAborted(); });
  await assert.rejects(f.search('Operation 0', null, { signal: controller.signal }), { name: 'AbortError' });
});
test('point identity is stable across JSON object key order after transfer', t => {
  const f = fixture(t, { count: 1 });
  const first = { ...f.definitions[0], inputs: { a: { ask: 'A' }, b: { ask: 'B' } } };
  const second = { ...f.definitions[0], inputs: { b: { ask: 'B' }, a: { ask: 'A' } } };
  assert.deepEqual(identity(first, configuration()), identity(second, configuration()));
});
test('packing reduces a larger ranked group to fit evaluation budget', async t => {
  const f = fixture(t, { topK: 10 });
  f.definitions.forEach(item => { delete item.routingScope; });
  // Regenerate matching points for the changed cards.
  f.points.clear();
  await f.service.sync(f.definitions, configuration(), AbortSignal.timeout(1000));
  const result = await f.search('Operation 0', null, { executionBudget: new RequestExecutionBudget({ maxModelCalls: 7 }) });
  assert.ok(result.definitions.length < 10);
  assert.ok(result.trace.evaluations + 2 <= 7);
});

test('lexical routing requires no network and retains authorized competing group', async t => {
  const f = fixture(t, { count: 3 });
  process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'lexical';
  f.definitions[0].aliases = ['hd'];
  f.definitions[0].routingGroup = 'contract';
  f.definitions[1].routingGroup = 'contract';
  const result = await f.search('hd');
  assert.deepEqual(result.definitions.map(d => d.id), [f.definitions[0].id, f.definitions[1].id]);
  assert.equal(result.trace.method, 'bm25');
  assert.equal(result.trace.indexStatus, 'not_required');
  assert.equal(f.calls.length, 0);
  f.definitions.splice(1, 1);
  assert.equal((await f.search('hd')).definitions.length, 1);
});

test('lexical no-match is uncertainty, not a chat decision', async t => {
  const f = fixture(t); process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'lexical';
  await assert.rejects(f.search('zzzzzz'), { code: 'ROUTING_RETRIEVAL_EMPTY' });
  assert.equal(f.calls.length, 0);
});

test('competing group overflow escalates instead of dropping a sibling', async t => {
  const f = fixture(t, { count: 3, topK: 2 }); process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'lexical';
  f.definitions.forEach(d => { d.routingGroup = 'contract'; });
  f.definitions[0].aliases = ['hd'];
  await assert.rejects(f.search('hd'), { code: 'ROUTING_RETRIEVAL_COMPETING_CANDIDATES' });
});

test('lexical publish checks scope without depending on embedding or Qdrant', async t => {
  fixture(t); process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'lexical';
  const { PluginRegistry } = require('../src/backend/automation/registry');
  const shared = require('../src/backend/automation/workflow_retrieval').service;
  const sync = t.mock.method(shared, 'sync', async () => { throw new Error('Unexpected index write'); });
  const bundle = { templates: [{ enabled: true, routingScope: 'targeted' }] };
  await PluginRegistry.prototype.indexRoutingBundle.call({}, bundle);
  assert.equal(sync.mock.callCount(), 0);
  delete bundle.templates[0].routingScope;
  await assert.rejects(PluginRegistry.prototype.indexRoutingBundle.call({}, bundle), /routingScope/);
});

test('hybrid chat with a missing collection never creates it', async t => {
  const f = fixture(t);
  const original = f.service.fetch;
  t.mock.method(f.service, 'fetch', async (url, options) => url.includes('/collections/') && !url.includes('/points')
    ? { ok: false, status: 404 } : original(url, options));
  await assert.rejects(f.search(), { code: 'ROUTING_RETRIEVAL_INDEX_MISSING' });
  assert.equal(f.calls.filter(call => call.method === 'PUT' || call.url.endsWith('/api/embed')).length, 0);
});

for (const count of [20, 50, 100]) test(`lexical plumbing with ${count} workflows preserves the matching alias`, async t => {
  const f = fixture(t, { count }); process.env.CHAT_ROUTING_RETRIEVAL_METHOD = 'lexical';
  f.definitions.at(-1).aliases = ['uniquealias'];
  const result = await f.search('uniquealias');
  assert.deepEqual(result.definitions.map(d => d.id), [f.definitions.at(-1).id]);
  assert.equal(f.calls.length, 0);
});
