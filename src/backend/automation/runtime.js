'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../storage');
const { getExportsDirectory } = require('../utils/export_paths');
const { validateInputs, validateValue, resolve, condition, hash, ensure, error } = require('./contract');
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const active = ['CREATED', 'WAITING_INPUT', 'READY', 'RUNNING', 'NEEDS_REVIEW'];
const mutexes = new Map();
async function locked(key, operation) {
  const previous = mutexes.get(key) || Promise.resolve();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const current = previous.then(() => gate); mutexes.set(key, current);
  await previous;
  try { return await operation(); } finally { release(); if (mutexes.get(key) === current) mutexes.delete(key); }
}
function event(run, type, detail = {}) {
  run.events ||= []; run.events.push({ id: run.events.length + 1, type, at: new Date().toISOString(), ...detail });
}
async function executePure(step, state) {
  if (step.type === 'transform') return resolve(step.config?.mapping || {}, state);
  if (step.type === 'condition') return condition(step.config, state);
  if (step.type === 'assert') { ensure(condition(step.config, state), step.config.message || 'Điều kiện kết quả chưa đạt.'); return { valid: true }; }
  if (step.type === 'collect') {
    const missing = step.config.slots.filter(key => state.input[key] === undefined || state.input[key] === '');
    ensure(!missing.length, 'Cần bổ sung input.'); return { collected: true };
  }
  if (step.type === 'delay') return { delayedMs: step.config.delayMs };
  throw error('Primitive không được hỗ trợ.');
}
class AutomationRuntime {
  constructor(repository, registry, { executeSql, executeSource, authorizeContext, enabled = () => process.env.WORKFLOW_PLUGINS_ENABLED === 'true', leaseMs = 90000 } = {}) {
    this.repository = repository; this.registry = registry; this.executeSql = executeSql || require('./sql').executeBinding;
    this.executeSource = executeSource || require('./data_sources').executeSource;
    this.authorizeContext = authorizeContext || (async ownerId => {
      if (ownerId.startsWith('embed:')) { const config=require('../services/embed_chat_service').configs.find(c=>c.id===ownerId.split(':')[1] && c.isActive); if(!config) throw error('Widget đã bị tắt.',403); return {accountId:ownerId,tenantId:`embed:${config.id}`,permissions:['sql:read','knowledge:read']}; }
      const account = require('../services/auth_service').accounts.find(item => item.id === ownerId && item.isActive !== false);
      if (!account) throw error('Tài khoản không còn hoạt động.', 403);
      return { accountId: account.id, tenantId: account.tenantId, permissions: account.role === 'admin' ? ['admin'] : ['sql:read', 'knowledge:read'] };
    });
    this.enabled = enabled; this.leaseMs = leaseMs; this.controllers = new Map(); this.jobs = new Set(); this.stopping = false;
  }
  assertEnabled() { if (!this.enabled()) throw error('Workflow/plugin đang tắt. Quản trị viên cần bật cấu hình phase 1.', 503); }
  owner(context) { ensure(context.accountId, 'Cần tài khoản đã xác thực.'); return context.accountId; }
  async owned(id, context) {
    const run = await this.repository.get('runs', id);
    if (!run || run.ownerId !== this.owner(context)) throw error('Không tìm thấy tác vụ.', 404);
    return run;
  }
  view(run) {
    const presentation = structuredClone(run.definition.output.presentation || {});
    let result = Object.hasOwn(run, 'result') ? structuredClone(run.result) : null;
    for (const [field, mapping] of Object.entries(run.definition.output.mapping || {})) {
      const reference = typeof mapping === 'string' && mapping.match(/^\{\{\s*steps\.([\w-]+)\.rows\s*\}\}$/);
      const step = reference && run.definition.workflow.steps.find(item => item.id === reference[1] && ['sql','source'].includes(item.type));
      const binding = step && run.definition.bindings?.[step.config.bindingRef];
      if (binding?.resultMapping?.length) {
        const dictionary = require('../services/dictionary_service');
        const mapped = binding.resultMapping.filter(m=>{ const table=dictionary.tablesStore.find(t=>t.tableId===m.tableId && t.dbSourceId===binding.dbSourceId && t.isActive!==false); return table && require('./column_mapping').mappedColumns(table,dictionary).some(c=>c.column.columnName===m.columnName && (c.relation?.id||null)===(m.relationId||null)); });
        mapped.sort((a,b)=>{ const rank=m=>dictionary.tablesStore.find(t=>t.tableId===m.tableId)?.columns.find(c=>c.columnName===m.columnName)?.ordinalPosition??9999; return rank(a)-rank(b); });
        presentation.columns ||= {}; presentation.columns[field]=mapped.map(m=>m.key); presentation.labels ||= {};
        for(const m of mapped) { const table=dictionary.tablesStore.find(t=>t.tableId===m.tableId); const column=require('./column_mapping').mappedColumns(table,dictionary).find(c=>c.column.columnName===m.columnName); presentation.labels[`${field}.${m.key}`]=column.label; }
        if(Array.isArray(result?.[field])) result[field]=result[field].map(row=>Object.fromEntries(mapped.filter(m=>Object.hasOwn(row,m.key)).map(m=>[m.key,row[m.key]])));
        continue;
      }
      if (!binding || require('./data_sources').kind(binding) !== 'sql' || binding.tables.length !== 1) continue;
      const [schema, name] = binding.tables[0].split('.');
      const table = require('../services/dictionary_service').tablesStore.find(item => item.dbSourceId === binding.dbSourceId && item.tableName === name && (item.schemaName || 'dbo') === schema);
      if (!table) continue;
      const columns = table.isActive === false ? [] : [...table.columns].filter(column => column.isVisible !== false).sort((a, b) => (a.ordinalPosition ?? 9999) - (b.ordinalPosition ?? 9999));
      presentation.columns ||= {}; presentation.columns[field] = columns.map(column => column.columnName);
      presentation.labels ||= {};
      for (const column of columns) presentation.labels[`${field}.${column.columnName}`] = column.displayName?.trim() || presentation.labels[`${field}.${column.columnName}`] || column.columnName;
      if (Array.isArray(result?.[field])) result[field] = result[field].map(row => Object.fromEntries(columns.filter(column => Object.hasOwn(row, column.columnName)).map(column => [column.columnName, row[column.columnName]])));
    }
    return {
      id: run.id, runId: run.id, revision: run.revision, status: run.status,
      templateId: run.templateId, name: run.definition.name, conversationId: run.conversationId,
      packageVersion: run.definition.packageVersion, overlayVersion: run.definition.overlayVersion,
      inputs: run.input, tokenUsage: run.tokenUsage || null,
      inputLabels: Object.fromEntries(Object.entries(run.definition.inputs).map(([key, slot]) => [key, slot.label || key])),
      provenance: run.provenance, missingInputs: [...run.missing, ...run.invalid],
      actions: terminal.has(run.status) ? [] : ['cancel', ...(run.status !== 'RUNNING' ? ['resume'] : [])],
      steps: run.definition.workflow.steps.map((step, index) => ({
        id: step.id, name: step.name || `Bước ${index + 1}`,
        status: run.attempts[step.id]?.status || 'PENDING', attempts: run.attempts[step.id]?.count || 0
      })),
      result, presentation,
      artifacts: (run.artifacts || []).map(artifact => ({
        id: artifact.id, filename: artifact.filename, expiresAt: artifact.expiresAt,
        downloadUrl: `/api/automation-runs/${encodeURIComponent(run.id)}/artifacts/${artifact.id}`
      })),
      error: run.error || null, createdAt: run.createdAt, updatedAt: run.updatedAt
    };
  }
  async list(context, conversationId) { return (await this.repository.list('runs', { ownerId: this.owner(context), conversationId })).slice(0, 100).map(run => this.view(run)); }
  async pending(context, conversationId) { return (await this.repository.list('runs', { ownerId: this.owner(context), conversationId, statuses: active }))[0] || null; }
  async create(templateId, input, context, { conversationId, requestId, tokenUsage } = {}) {
    this.assertEnabled(); const ownerId = this.owner(context);
    ensure(typeof conversationId === 'string' && conversationId.length > 0 && conversationId.length <= 150, 'Cần conversationId hợp lệ.');
    const key = `automation-conversation:${ownerId}:${conversationId}`;
    return locked(key, async () => {
      const operation = async () => {
        const digest = hash({ templateId, input, conversationId });
        const id = requestId ? `auto_${hash({ ownerId, conversationId, requestId }).slice(0, 40)}` : `auto_${crypto.randomUUID()}`;
        const previous = await this.repository.get('runs', id);
        if (previous) { ensure(previous.requestHash === digest, 'Request ID đã dùng với nội dung khác.'); return this.view(previous); }
        if (await this.pending(context, conversationId)) throw error('Hội thoại đang có tác vụ chờ. Hãy tiếp tục hoặc hủy tác vụ đó.', 409);
        const definition = await this.registry.getTemplate(templateId, context);
        const provenance = Object.fromEntries(Object.keys(input || {}).map(key => [key, { source: 'user', at: new Date().toISOString() }]));
        const checked = validateInputs(definition, input, provenance);
        const run = { id, ownerId, conversationId, templateId, requestHash: digest, definition, input: checked.values, provenance: checked.provenance, missing: checked.missing, invalid: checked.invalid, status: checked.valid ? 'READY' : 'WAITING_INPUT', nextIndex: 0, outputs: {}, attempts: {}, artifacts: [], events: [], createdAt: new Date().toISOString() };
        if (definition.review?.mode === 'required') { run.status = 'NEEDS_REVIEW'; run.error = 'Template yêu cầu kiểm tra AI. Provider phase 2 chưa được tích hợp; tác vụ chưa được thực thi.'; }
        if (tokenUsage) run.tokenUsage = structuredClone(tokenUsage);
        event(run, 'created', { status: run.status });
        return this.view(await this.repository.put('runs', run));
      };
      const result = storage.enabled() ? await storage.lease(key, operation) : await operation();
      if (result?.skipped) throw error('Hội thoại đang được cập nhật. Hãy thử lại.', 409);
      return result;
    });
  }
  async inputs(id, values, context, revision, tokenUsage) {
    this.assertEnabled(); const run = await this.owned(id, context);
    if (!Number.isInteger(revision) || revision !== run.revision) throw error('Revision tác vụ đã thay đổi.', 409);
    if (!['WAITING_INPUT', 'READY'].includes(run.status)) throw error('Không thể sửa input khi đang chạy hoặc cần kiểm tra tác động.', 409);
    ensure(!run.artifacts.length, 'Tác vụ đã tạo file; hãy tạo lượt chạy mới để đổi input.');
    const provenance = { ...run.provenance, ...Object.fromEntries(Object.keys(values).map(key => [key, { source: 'user', at: new Date().toISOString() }])) };
    const checked = validateInputs(run.definition, { ...run.input, ...values }, provenance);
    Object.assign(run, { input: checked.values, provenance: checked.provenance, missing: checked.missing, invalid: checked.invalid, status: checked.valid ? 'READY' : 'WAITING_INPUT', outputs: {}, attempts: {}, nextIndex: 0, error: null, lease: null });
    event(run, 'inputs_updated', { status: run.status });
    if (tokenUsage?.available) { const previous = run.tokenUsage || {}; run.tokenUsage = { available: true, ...Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'calls'].map(key => [key, (previous[key] || 0) + (tokenUsage[key] || 0)])) }; }
    return this.view(await this.repository.put('runs', run, revision));
  }
  async resume(id, context, revision) {
    this.assertEnabled(); const run = await this.owned(id, context);
    if (revision !== run.revision) throw error('Revision tác vụ đã thay đổi.', 409);
    ensure(['READY', 'WAITING_INPUT'].includes(run.status), 'Tác vụ không thể tiếp tục tự động.');
    const checked = validateInputs(run.definition, run.input, run.provenance);
    if (!checked.valid || run.missing.length || run.invalid.length) return this.view(run);
    run.status = 'READY'; event(run, 'resumed');
    return this.view(await this.repository.put('runs', run, revision));
  }
  async cancel(id, context, revision) {
    const run = await this.owned(id, context);
    if (revision !== run.revision) throw error('Revision tác vụ đã thay đổi.', 409);
    if (terminal.has(run.status)) return this.view(run);
    run.status = 'CANCELLED'; run.lease = null; event(run, 'cancelled');
    const saved = await this.repository.put('runs', run, revision);
    this.controllers.get(id)?.abort(); return this.view(saved);
  }
  async process(id) {
    if (!this.enabled() || this.stopping) return;
    let run = await this.repository.get('runs', id);
    if (!run || !['READY', 'RUNNING'].includes(run.status) || (run.lease && run.lease.expiresAt > Date.now())) return;
    if (run.status === 'RUNNING') {
      const interrupted = run.definition.workflow.steps[run.nextIndex];
      if (interrupted?.type === 'export' || (interrupted?.type === 'source' && require('./api_http').hasWriteEffect(run.definition.bindings[interrupted.config.bindingRef]))) {
        run.status = 'NEEDS_REVIEW'; run.error = 'Gián đoạn khi thực hiện tác vụ có tác động. Kiểm tra kết quả trước khi tạo lượt chạy mới.'; run.lease = null; event(run, 'needs_review');
        await this.repository.put('runs', run, run.revision); return;
      }
    }
    const token = crypto.randomUUID(); run.status = 'RUNNING'; run.lease = { token, expiresAt: Date.now() + this.leaseMs };
    try { run = await this.repository.put('runs', run, run.revision); } catch (failure) { if (failure.statusCode === 409) return; throw failure; }
    const controller = new AbortController(); this.controllers.set(id, controller);
    try {
      for (;;) {
        run = await this.repository.get('runs', id);
        if (run.status !== 'RUNNING' || run.lease?.token !== token || controller.signal.aborted) return;
        const context = await this.authorizeContext(run.ownerId);
        if (!await this.registry.canContinue(run.definition, context)) throw error('Quyền sử dụng template đã bị thu hồi.', 403);
        const step = run.definition.workflow.steps[run.nextIndex];
        const state = { input: run.input, steps: run.outputs };
        if (!step) {
          const result = resolve(run.definition.output.mapping, state);
          const failures = validateValue(result, run.definition.output.schema);
          ensure(!failures.length, 'Kết quả không đạt output contract.');
          run.result = result; run.status = 'SUCCEEDED'; run.lease = null; event(run, 'completed');
          await this.repository.put('runs', run, run.revision); return;
        }
        if (!condition(step.when, state)) {
          run.attempts[step.id] = { status: 'SKIPPED', count: 0 }; run.nextIndex++; event(run, 'step_skipped', { stepId: step.id });
          await this.repository.put('runs', run, run.revision); continue;
        }
        if (step.type === 'collect') {
          const missing = step.config.slots.filter(key => run.input[key] === undefined || run.input[key] === '').map(key => ({ key, label: run.definition.inputs[key].label || key, ask: run.definition.inputs[key].ask, schema: run.definition.inputs[key].schema }));
          if (missing.length) { run.status = 'WAITING_INPUT'; run.missing = missing; run.lease = null; event(run, 'waiting_input'); await this.repository.put('runs', run, run.revision); return; }
        }
        const count = (run.attempts[step.id]?.count || 0) + 1;
        run.attempts[step.id] = { count, status: 'RUNNING', startedAt: new Date().toISOString() }; run.lease.expiresAt = Date.now() + this.leaseMs;
        event(run, 'step_started', { stepId: step.id }); run = await this.repository.put('runs', run, run.revision);
        const sourceBinding=step.type==='source'?run.definition.bindings[step.config.bindingRef]:null;
        const timer = setTimeout(() => controller.abort(), Math.min(60000, step.timeoutMs || (sourceBinding?.type==='api'?sourceBinding.timeoutMs || 30000:45000)));
        let output, failure;
        try {
          if (step.type === 'sql') output = await this.executeSql(run.definition.bindings[step.config.bindingRef], run.input, { ...context, state, signal: controller.signal });
          else if (step.type === 'source') {
            const binding=run.definition.bindings[step.config.bindingRef];
            output = require('./data_sources').kind(binding) === 'sql' ? await this.executeSql(binding,run.input,{...context,state,signal:controller.signal}) : await this.executeSource(binding,state,{...context,runId:run.id,signal:controller.signal});
          }
          else if (step.type === 'export') output = await this.export(step, state, run);
          else {
            if (step.type === 'delay') await new Promise((done, reject) => {
              const onAbort = () => { clearTimeout(wait); reject(error('Tác vụ bị dừng.')); };
              const wait = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); done(); }, step.config.delayMs);
              controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            output = await executePure(step, state);
          }
          ensure(!controller.signal.aborted, 'Tác vụ hết thời gian hoặc bị dừng.');
          if (step.outputSchema) { const failures = validateValue(output, step.outputSchema); ensure(!failures.length, 'Kết quả bước không đúng schema.'); }
        } catch (caught) { failure = caught; } finally { clearTimeout(timer); }
        const fresh = await this.repository.get('runs', id);
        if (fresh.status !== 'RUNNING' || fresh.lease?.token !== token) return;
        run = fresh;
        if (failure) {
          const maxAttempts = step.retry?.maxAttempts || 1;
          run.attempts[step.id].status = 'FAILED'; event(run, 'step_failed', { stepId: step.id });
          if(step.type==='source' && require('./api_http').hasWriteEffect(run.definition.bindings[step.config.bindingRef]) && (failure.apiRequestStarted || output!==undefined)) {
            run.status='NEEDS_REVIEW';run.error='API ghi dữ liệu đã được gửi nhưng chưa xác nhận được kết quả. Kiểm tra hệ thống đích trước khi chạy lại.';run.lease=null;event(run,'needs_review');await this.repository.put('runs',run,run.revision);return;
          }
          if (count < maxAttempts && step.type !== 'export' && !(step.type==='source' && require('./api_http').hasWriteEffect(run.definition.bindings[step.config.bindingRef])) && !controller.signal.aborted) { await this.repository.put('runs', run, run.revision); continue; }
          throw failure;
        }
        ensure(Buffer.byteLength(JSON.stringify(output ?? null)) <= 1024 * 1024, 'Kết quả bước quá lớn.');
        run.outputs[step.id] = output;
        if (output?.artifact) run.artifacts.push(output.artifact);
        run.attempts[step.id].status = 'SUCCEEDED'; run.attempts[step.id].finishedAt = new Date().toISOString(); run.nextIndex++;
        run.lease.expiresAt = Date.now() + this.leaseMs; event(run, 'step_completed', { stepId: step.id });
        await this.repository.put('runs', run, run.revision);
      }
    } catch (failure) {
      const fresh = await this.repository.get('runs', id);
      if (fresh?.status === 'RUNNING' && fresh.lease?.token === token) {
        fresh.status = 'FAILED'; fresh.error = require('../intelligent_core/security_guard').maskSensitiveData(failure.message).slice(0, 400); fresh.lease = null; event(fresh, 'failed');
        await this.repository.put('runs', fresh, fresh.revision);
      }
    } finally { this.controllers.delete(id); }
  }
  async export(step, state, run) {
    const rows = resolve(step.config.data, state);
    ensure(Array.isArray(rows), 'Dữ liệu xuất cần là danh sách.');
    if (!rows.length) return { empty: true, filename: null };
    const format = resolve(step.config.format || 'csv', state); ensure(['csv', 'xlsx'].includes(format), 'Định dạng file chưa hỗ trợ.');
    const artifactId = crypto.randomUUID(), filename = `${String(resolve(step.config.filename || 'Bao_cao', state)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 70)}.${format}`;
    const directory = path.join(getExportsDirectory(), 'automation'); fs.mkdirSync(directory, { recursive: true });
    const storageName = `${artifactId}.${format}`, destination = path.join(directory, storageName);
    const xlsx = require('xlsx'), sheet = xlsx.utils.json_to_sheet(rows);
    if (format === 'csv') {
      const safeRows = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'string' && /^[=+@-]/.test(value) ? `'${value}` : value])));
      fs.writeFileSync(destination, '\uFEFF' + xlsx.utils.sheet_to_csv(xlsx.utils.json_to_sheet(safeRows)), { mode: 0o600 });
    } else { const workbook = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(workbook, sheet, 'Data'); xlsx.writeFile(workbook, destination); }
    return { artifactId, filename, empty: false, artifact: { id: artifactId, filename, storageName, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() } };
  }
  async artifact(id, artifactId, context) {
    const run = await this.owned(id, context), artifact = run.artifacts.find(item => item.id === artifactId);
    if (!artifact || Date.parse(artifact.expiresAt) <= Date.now()) throw error('File không tồn tại hoặc đã hết hạn.', 404);
    return { ...artifact, path: path.join(getExportsDirectory(), 'automation', path.basename(artifact.storageName)) };
  }
  async tick() {
    if (this.stopping || !this.enabled()) return;
    const runs = await this.repository.list('runs', { statuses: ['READY', 'RUNNING'] });
    for (const run of runs) {
      if (this.jobs.size >= 2) break;
      if (this.controllers.has(run.id) || run.lease?.expiresAt > Date.now()) continue;
      const promise = storage.run(() => this.process(run.id), { independent: true }).catch(failure => console.error('[Automation]', failure.code || failure.message)).finally(() => this.jobs.delete(promise));
      this.jobs.add(promise);
    }
  }
  start() { if (this.timer) return; this.stopping = false; this.timer = setInterval(storage.detach(() => this.tick().catch(failure => console.error('[Automation]', failure.code || failure.message))), 1000); this.timer.unref(); }
  async stop() { this.stopping = true; clearInterval(this.timer); this.timer = null; await Promise.allSettled([...this.jobs]); }
}
module.exports = { AutomationRuntime, executePure, terminal, active };
