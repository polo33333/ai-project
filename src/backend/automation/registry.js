'use strict';
const { validatePackage, validateInputs, hash, error, ensure, condition, resolve, validateValue } = require('./contract');
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function scope(context) { return context.tenantId || `account:${context.accountId}`; }
function authorized(definition, context) {
  if (!context.accountId) return false;
  const audience = definition.audience;
  return (!audience?.accountIds?.length || audience.accountIds.includes(context.accountId)) && (!audience?.tenantIds?.length || audience.tenantIds.includes(scope(context)));
}
function requireAdmin(context) { if (!context.permissions?.includes('admin')) throw error('Cần quyền quản trị definition.', 403); }
class PluginRegistry {
  constructor(repository) { this.repository = repository; }
  async import(bundle, context, revision = null) {
    requireAdmin(context); validatePackage(bundle);
    const previous = await this.repository.get('catalog', bundle.manifest.id);
    if (previous && revision !== previous.revision) throw error('Cần revision hiện tại để sửa gói.', 409);
    const latestVersion = Math.max(0, ...(previous?.versions || []).map(version => version.manifest.version));
    if (bundle.manifest.version <= latestVersion) throw error('Version mới phải lớn hơn mọi version đã publish.', 409);
    const record = { ...(previous || {}), id: bundle.manifest.id, draft: structuredClone(bundle), enabled: previous?.enabled ?? true, overlays: previous?.overlays || {}, createdAt: previous?.createdAt || new Date().toISOString(), createdBy: previous?.createdBy || context.accountId, updatedBy: context.accountId, testedHash: null, lastTest: null };
    return this.repository.put('catalog', record, previous?.revision ?? null);
  }
  async list(context, { admin = false } = {}) {
    if (admin) requireAdmin(context);
    const records = await this.repository.list('catalog');
    if (admin) return records.filter(record => record.draft).map(record => ({ ...record, draft: { ...record.draft, templates: record.draft.templates.filter(template => !record.deletedTemplates?.[template.id]) } })).filter(record => record.draft.templates.length);
    const definitions = [];
    for (const record of records) {
      if (!record.enabled || !record.published) continue;
      try { await this.dependencies(record.published); } catch (_) { continue; }
      const overlay = record.overlays?.[scope(context)];
      const bundle = overlay?.published && overlay.baseVersion === record.published.manifest.version ? overlay.published : record.published;
      for (const template of bundle.templates) if (!record.deletedTemplates?.[template.id] && template.enabled !== false && authorized(template, context) && authorized(bundle.manifest, context)) definitions.push({ ...structuredClone(template), id: `${record.id}/${template.id}`, localId: template.id, packageId: record.id, packageVersion: bundle.manifest.version, domain: template.domain || bundle.manifest.domain || '', tags: [...new Set([...(bundle.manifest.tags || []), ...(template.tags || [])])], packageAudience: bundle.manifest.audience, overlayVersion: overlay?.published === bundle ? overlay.version : null, instructions: template.instructions || '', definitionHash: hash(template) });
    }
    return definitions;
  }
  async getTemplate(id, context) {
    const template = (await this.list(context)).find(item => item.id === id);
    if (!template) throw error('Template không có hoặc không được phép sử dụng.', 404);
    return template;
  }
  async canContinue(definition, context) {
    if (!authorized(definition, context) || !authorized({ audience: definition.packageAudience }, context)) return false;
    const current = await this.repository.get('catalog', definition.packageId);
    if (!current?.published || !authorized(current.published.manifest, context)) return false;
    const currentTemplate = current.published.templates.find(item => item.id === definition.localId);
    return !currentTemplate || authorized(currentTemplate, context);
  }
  async validate(id, context) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record) throw error('Gói không tồn tại.', 404);
    validatePackage(record.draft); await this.dependencies(record.draft);
    for (const template of record.draft.templates) for (const binding of Object.values(template.bindings || {})) {
      if (require('./data_sources').kind(binding) !== 'sql') {
        if (binding.type === 'file' && !binding.documentId.includes('{{')) ensure(require('../services/library_service').findDocument(binding.documentId), 'File không còn trong Thư viện.');
        continue;
      }
      const connector = require('../services/sql_connector');
      ensure(connector.dbSources.some(source => source.id === binding.dbSourceId && (source.mode === 'live' || source.type === 'Direct Live Connection')), `Binding chưa có nguồn live: ${binding.dbSourceId}`);
      for (const table of binding.tables) {
        ensure(require('./sql').tableAvailable(binding, table, connector), `Binding không tồn tại trong catalog hoặc đã tắt: ${table}`);
      }
    }
    return { valid: true, hash: hash(record.draft), templates: record.draft.templates.length };
  }
  async dependencies(bundle, path = []) {
    const current = bundle.manifest.id;
    ensure(!path.includes(current), 'Vòng dependency không được hỗ trợ.');
    for (const dependency of bundle.manifest.dependencies || []) {
      const record = await this.repository.get('catalog', dependency.id);
      ensure(record?.enabled && record.published?.manifest.version === dependency.version, `Dependency chưa khả dụng: ${dependency.id}@${dependency.version}`);
      await this.dependencies(record.published, [...path, current]);
    }
  }
  async test(id, context) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record) throw error('Gói không tồn tại.', 404);
    const report = await this.testBundle(record.draft);
    await this.repository.put('catalog', { ...record, testedHash: report.passed ? hash(record.draft) : null, lastTest: report }, record.revision);
    return report;
  }
  async testBundle(bundle) {
    validatePackage(bundle); const results = [];
    for (const template of bundle.templates) for (const [index, fixture] of template.fixtures.entries()) {
      try {
        const input = validateInputs(template, fixture.input).values, state = { input, steps: {} };
        for (const step of template.workflow.steps) {
          if (!condition(step.when, state)) continue;
          let output;
          if (step.type === 'sql' || (step.type === 'source' && require('./data_sources').kind(template.bindings[step.config.bindingRef]) !== 'previous')) {
            ensure(Object.hasOwn(fixture.stepResults || {}, step.id), 'Nguồn dữ liệu ngoài cần dữ liệu giả lập stepResults.');
            output = fixture.stepResults[step.id];
          } else if (step.type === 'source') output = await require('./data_sources').executeSource(template.bindings[step.config.bindingRef],state);
          else if (step.type === 'export') output = { artifactId: 'fixture', filename: 'fixture.csv', empty: false };
          else output = await require('./runtime').executePure(step, state);
          state.steps[step.id] = output;
        }
        const output = resolve(template.output.mapping, state), failures = validateValue(output, template.output.schema);
        ensure(!failures.length, failures.join('; '));
        ensure(hash(output) === hash(fixture.expected), 'Kết quả không khớp expected.');
        results.push({ templateId: template.id, fixture: index + 1, passed: true });
      } catch (failure) { results.push({ templateId: template.id, fixture: index + 1, passed: false, error: failure.message }); }
    }
    return { passed: results.every(item => item.passed), results, at: new Date().toISOString() };
  }
  async publish(id, context, revision) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record || record.revision !== revision) throw error('Revision gói đã thay đổi.', 409);
    await this.validate(id, context);
    ensure(!(record.versions || []).some(version => version.manifest.version === record.draft.manifest.version), 'Version đã publish là bất biến; hãy tạo draft version mới.');
    ensure(record.testedHash === hash(record.draft) && record.lastTest?.passed, 'Phải chạy fixture thành công trên draft hiện tại trước publish.');
    return this.repository.put('catalog', { ...record, published: structuredClone(record.draft), publishedAt: new Date().toISOString(), publishedBy: context.accountId, versions: [...(record.versions || []), structuredClone(record.draft)] }, revision);
  }
  async enable(id, enabled, context, revision) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record || record.revision !== revision) throw error('Revision gói đã thay đổi.', 409);
    ensure(typeof enabled === 'boolean', 'enabled phải là boolean.');
    return this.repository.put('catalog', { ...record, enabled }, revision);
  }
  async rollback(id, version, context, revision) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record || record.revision !== revision) throw error('Revision gói đã thay đổi.', 409);
    const published = record.versions?.find(bundle => bundle.manifest.version === version);
    ensure(published, 'Version rollback không tồn tại.'); await this.dependencies(published);
    return this.repository.put('catalog', { ...record, published: structuredClone(published) }, revision);
  }
  async overlay(id, scopeId, bundle, context, revision) {
    requireAdmin(context); const record = await this.repository.get('catalog', id);
    if (!record?.published || record.revision !== revision) throw error('Gói chưa publish hoặc revision đã thay đổi.', 409);
    ensure(typeof scopeId === 'string' && scopeId.length <= 150 && scopeId.length > 0, 'Scope không hợp lệ.');
    validatePackage(bundle); ensure(bundle.manifest.id === id && bundle.manifest.version === record.published.manifest.version, 'Overlay phải giữ package ID/base version.');
    ensure(hash(bundle.manifest) === hash(record.published.manifest), 'Overlay không được thay grants/manifest.');
    ensure(bundle.templates.length === record.published.templates.length, 'Overlay không được thêm template.');
    for (const template of bundle.templates) {
      const base = record.published.templates.find(item => item.id === template.id);
      ensure(base && hash(template.audience || {}) === hash(base.audience || {}), 'Overlay không được thay audience.');
      ensure(base.review?.mode !== 'required' || template.review?.mode === 'required', 'Overlay không được hạ kiểm tra AI bắt buộc.');
      ensure(base.enabled !== false || template.enabled === false, 'Overlay không được bật template đã bị vô hiệu hóa trong gói gốc.');
      for (const [key, slot] of Object.entries(base.inputs)) {
        if (slot.required) ensure(template.inputs[key]?.required === true, 'Overlay không được bỏ slot bắt buộc.');
        if (slot.requiredWhen) ensure(hash(template.inputs[key]?.requiredWhen) === hash(slot.requiredWhen), 'Overlay không được hạ điều kiện slot bắt buộc.');
      }
      ensure(template.allowedCapabilities.every(capability => base.allowedCapabilities.includes(capability)), 'Overlay không được mở rộng capability.');
      for (const [key, binding] of Object.entries(template.bindings || {})) {
        const grant = base.bindings?.[key];
        ensure(grant && binding.dbSourceId === grant.dbSourceId && hash(binding.sql) === hash(grant.sql) && hash(binding.tables) === hash(grant.tables), 'Overlay không được mở rộng connection, bảng hoặc SQL đã cấp quyền.');
      }
    }
    await this.dependencies(bundle);
    const report = await this.testBundle(bundle); ensure(report.passed, 'Fixture overlay chưa đạt.');
    return this.repository.put('catalog', { ...record, overlays: { ...record.overlays, [scopeId]: { baseVersion: bundle.manifest.version, version: (record.overlays?.[scopeId]?.version || 0) + 1, published: structuredClone(bundle), publishedBy: context.accountId, test: report } } }, revision);
  }
  async match(question, context) {
    const definitions = await this.list(context), query = normalize(question);
    const tokens = new Set(query.split(' '));
    const candidates = definitions.map(definition => {
      const phrases = [...definition.examples, definition.name];
      const exact = phrases.some(phrase => normalize(phrase) === query);
      const score = exact ? 1 : Math.max(...phrases.map(phrase => {
        const expected = new Set(normalize(phrase).split(' '));
        const intersection = [...expected].filter(token => tokens.has(token)).length;
        return intersection / Math.max(tokens.size, expected.size, 1);
      }));
      return { definition, score, exact };
    }).filter(item => item.score >= 0.65).sort((a, b) => b.score - a.score);
    if (!candidates.length) return { status: 'no_match', candidates: [] };
    const close = candidates.filter(item => candidates[0].score - item.score < 0.15);
    return { status: close.length === 1 ? 'matched' : 'ambiguous', candidates: close.slice(0, 8), definition: close.length === 1 ? close[0].definition : null };
  }
}
module.exports = { PluginRegistry, authorized, scope, normalize, requireAdmin };
