'use strict';
const crypto = require('node:crypto');
const ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const CAPABILITIES = Object.freeze({ transform: 'data.transform', condition: 'data.condition', assert: 'data.validate', collect: 'input.collect', delay: 'runtime.delay', sql: 'sql.read', source: 'data.read', export: 'artifact.export' });
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function ensure(condition, message) { if (!condition) throw error(message); }
function safeObject(value, depth = 0) {
  ensure(depth < 32, 'Definition quá sâu.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) { ensure(!forbidden.has(key), 'Tên trường không an toàn.'); safeObject(child, depth + 1); }
}
function id(value) { ensure(typeof value === 'string' && ID.test(value) && !forbidden.has(value), `ID không hợp lệ: ${value}`); return value; }
function hash(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}
function get(value, path) {
  return String(path).split('.').reduce((current, key) => !forbidden.has(key) && current && Object.hasOwn(current, key) ? current[key] : undefined, value);
}
function resolve(value, state) {
  if (Array.isArray(value)) return value.map(item => resolve(item, state));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, state)]));
  if (typeof value !== 'string') return value;
  const match = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
  if (match) return get(state, match[1]);
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, path) => String(get(state, path) ?? ''));
}
const OPERATORS = {
  equals: (a, b) => a === b, notEquals: (a, b) => a !== b,
  greaterThan: (a, b) => a > b, lessThan: (a, b) => a < b,
  exists: a => a !== undefined && a !== null && a !== '',
  contains: (a, b) => Array.isArray(a) ? a.includes(b) : String(a ?? '').includes(String(b)),
  in: (a, b) => Array.isArray(b) && b.includes(a)
};
function condition(expression, state) {
  if (!expression) return true;
  ensure(expression && typeof expression === 'object' && Object.hasOwn(OPERATORS, expression.operator), 'Điều kiện không hợp lệ.');
  return OPERATORS[expression.operator](resolve(expression.left, state), resolve(expression.right, state));
}
function validateSchema(schema, depth = 0) {
  ensure(depth < 12 && schema && typeof schema === 'object', 'Schema không hợp lệ.');
  const supported = ['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'additionalProperties', 'format'];
  ensure(Object.keys(schema).every(key => supported.includes(key)), 'Schema chứa keyword chưa hỗ trợ.');
  ensure(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), 'Kiểu schema chưa hỗ trợ.');
  if (schema.type === 'object') {
    ensure(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), 'Schema object cần properties.');
    Object.entries(schema.properties).forEach(([key, child]) => { id(key); validateSchema(child, depth + 1); });
    ensure(!schema.required || (Array.isArray(schema.required) && schema.required.every(key => Object.hasOwn(schema.properties, key))), 'required phải thuộc properties.');
  }
  if (schema.type === 'array') validateSchema(schema.items, depth + 1);
  if (schema.enum) ensure(Array.isArray(schema.enum) && schema.enum.length > 0, 'enum rỗng.');
  if (schema.additionalProperties !== undefined) ensure(typeof schema.additionalProperties === 'boolean', 'additionalProperties cần boolean.');
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) if (schema[key] !== undefined) ensure(Number.isFinite(schema[key]), `Giới hạn ${key} không hợp lệ.`);
  if (schema.format) ensure(schema.type === 'string' && ['date', 'date-time'].includes(schema.format), 'format chưa hỗ trợ.');
}
function validateValue(value, schema, path = '') {
  const failures = [];
  if (value === undefined) return [`${path}: thiếu giá trị`];
  const validType = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value) : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value) : typeof value === schema.type && (schema.type !== 'number' || Number.isFinite(value));
  if (!validType) return [`${path}: cần kiểu ${schema.type}`];
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) failures.push(`${path}: ngoài danh sách lựa chọn`);
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) failures.push(`${path}: ngoài giới hạn`);
  if (typeof value === 'string') {
    if ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)) failures.push(`${path}: độ dài không hợp lệ`);
    if (schema.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) failures.push(`${path}: ngày không hợp lệ`);
    if (schema.format === 'date-time' && (!Number.isFinite(Date.parse(value)) || !/(Z|[+-]\d\d:\d\d)$/.test(value))) failures.push(`${path}: thời gian phải có múi giờ`);
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) failures.push(`${path}.${key}: thiếu giá trị`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties[key]) failures.push(...validateValue(child, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) failures.push(`${path}.${key}: trường không được phép`);
    }
  }
  if (schema.type === 'array') value.forEach((child, index) => failures.push(...validateValue(child, schema.items, `${path}[${index}]`)));
  return failures;
}
function validateInputs(definition, supplied = {}, provenance = {}) {
  safeObject(supplied);
  ensure(supplied && typeof supplied === 'object' && !Array.isArray(supplied), 'Input phải là object.');
  const values = { ...supplied }, sources = { ...provenance }, missing = [], invalid = [];
  for (const key of Object.keys(values)) ensure(Object.hasOwn(definition.inputs, key), `Input không được khai báo: ${key}`);
  for (const [key, slot] of Object.entries(definition.inputs)) {
    if (values[key] === undefined && Object.hasOwn(slot, 'default')) { values[key] = structuredClone(slot.default); sources[key] = { source: 'default', at: new Date().toISOString() }; }
    const absent = values[key] === undefined || values[key] === null || values[key] === '';
    const required = slot.required === true || (slot.requiredWhen && condition(slot.requiredWhen, { input: values }));
    if (absent && required) missing.push({ key, label: slot.label || key, ask: slot.ask, schema: slot.schema, choices: slot.schema.enum || null });
    else if (!absent) {
      const errors = validateValue(values[key], slot.schema, key);
      if (errors.length) invalid.push({ key, label: slot.label || key, ask: slot.ask, schema: slot.schema, errors });
    }
  }
  return { values, provenance: sources, missing, invalid, valid: !missing.length && !invalid.length };
}
function validatePackage(bundle) {
  safeObject(bundle);
  ensure(bundle && bundle.manifest && bundle.manifest.engineContractVersion === 1, 'engineContractVersion phải là 1.');
  id(bundle.manifest.id);
  ensure(Number.isSafeInteger(bundle.manifest.version) && bundle.manifest.version > 0, 'Version phải là số nguyên dương.');
  ensure(typeof bundle.manifest.name === 'string' && bundle.manifest.name.trim(), 'Gói cần tên.');
  const classification = definition => {
    if (definition.domain !== undefined) ensure(typeof definition.domain === 'string' && definition.domain.length <= 100, 'Domain cần chuỗi, tối đa 100 ký tự.');
    if (definition.tags !== undefined) ensure(Array.isArray(definition.tags) && definition.tags.every(tag => typeof tag === 'string' && tag.length <= 100), 'Tags cần danh sách chuỗi.');
    if (definition.audience) {
      ensure(Object.keys(definition.audience).every(key => ['accountIds', 'tenantIds'].includes(key)), 'Audience chứa loại grant chưa hỗ trợ.');
      for (const values of Object.values(definition.audience)) ensure(Array.isArray(values) && values.every(value => typeof value === 'string' && value.length > 0), 'Audience cần ID hợp lệ.');
    }
  };
  classification(bundle.manifest);
  ensure(Array.isArray(bundle.templates) && bundle.templates.length > 0 && bundle.templates.length <= 100, 'Gói cần 1–100 template.');
  ensure(!bundle.manifest.dependencies || (Array.isArray(bundle.manifest.dependencies) && bundle.manifest.dependencies.every(dep => ID.test(dep.id) && Number.isSafeInteger(dep.version))), 'Dependency không hợp lệ.');
  const identifiers = new Set();
  for (const template of bundle.templates) {
    classification(template);
    if (template.review) ensure(['off', 'advisory', 'required'].includes(template.review.mode), 'Chế độ review không hợp lệ.');
    id(template.id); ensure(!identifiers.has(template.id), 'Template ID trùng.'); identifiers.add(template.id);
    ensure(typeof template.name === 'string' && template.name.trim() && typeof template.description === 'string', 'Template cần name/description.');
    ensure(Array.isArray(template.examples) && template.examples.length && template.examples.every(value => typeof value === 'string' && value.trim()), 'Template cần examples để discovery.');
    ensure(template.inputs && typeof template.inputs === 'object' && !Array.isArray(template.inputs), 'Template cần inputs.');
    for (const [key, slot] of Object.entries(template.inputs)) {
      id(key); validateSchema(slot.schema);
      ensure(typeof slot.ask === 'string' && slot.ask.trim(), 'Slot cần câu hỏi bổ sung.');
      if (Object.hasOwn(slot, 'default')) ensure(!validateValue(slot.default, slot.schema).length, 'Giá trị mặc định sai schema.');
      if (slot.requiredWhen) condition(slot.requiredWhen, {});
    }
    ensure(Array.isArray(template.allowedCapabilities), 'Thiếu allowedCapabilities.');
    ensure(template.allowedCapabilities.every(value => Object.values(CAPABILITIES).includes(value)), 'Capability chưa hỗ trợ ở phase 1.');
    ensure(template.workflow && Array.isArray(template.workflow.steps) && template.workflow.steps.length > 0 && template.workflow.steps.length <= 50, 'Workflow cần 1–50 bước.');
    const steps = new Set();
    function references(value, allowedSteps) {
      if (value && typeof value === 'object') { Object.values(value).forEach(child => references(child, allowedSteps)); return; }
      if (typeof value !== 'string') return;
      for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) {
        const [root, key] = match[1].split('.');
        ensure((root === 'input' && (!key || Object.hasOwn(template.inputs, key))) || (root === 'steps' && key && allowedSteps.has(key)), `Reference không tồn tại hoặc phụ thuộc bước chưa chạy: ${match[1]}`);
      }
    }
    for (const step of template.workflow.steps) {
      id(step.id); ensure(!steps.has(step.id), 'Step ID trùng.');
      references(step.config, steps); references(step.when, steps);
      if (['sql','source'].includes(step.type)) references(template.bindings?.[step.config?.bindingRef], steps);
      steps.add(step.id);
      ensure(Object.hasOwn(CAPABILITIES, step.type) && template.allowedCapabilities.includes(CAPABILITIES[step.type]), 'Step/capability không được phép.');
      if (step.when) condition(step.when, {});
      if (step.outputSchema) validateSchema(step.outputSchema);
      ensure(!step.retry || (Number.isInteger(step.retry.maxAttempts) && step.retry.maxAttempts >= 1 && step.retry.maxAttempts <= 3), 'Retry cần 1–3 attempts.');
      if (['condition', 'assert'].includes(step.type)) condition(step.config, {});
      if (['sql','source'].includes(step.type)) {
        const binding = template.bindings?.[step.config?.bindingRef]; ensure(binding, 'Nguồn dữ liệu không tồn tại.');
        if (step.type === 'sql') ensure(require('./data_sources').kind(binding) === 'sql', 'Bước SQL cần nguồn SQL.');
      }
      if (step.type === 'collect') ensure(Array.isArray(step.config?.slots) && step.config.slots.every(key => template.inputs[key]), 'collect phải tham chiếu slot có thật.');
      if (step.type === 'delay') ensure(Number.isFinite(step.config?.delayMs) && step.config.delayMs >= 0 && step.config.delayMs <= 60000, 'Delay ngoài giới hạn.');
    }
    for (const [key, binding] of Object.entries(template.bindings || {})) {
      id(key);
      require('./data_sources').validateSource(binding);
      if (require('./data_sources').kind(binding) !== 'sql') continue;
      ensure(typeof binding.sql === 'string' && !binding.sql.includes('{{'), 'SQL phải cố định; dùng tham số @name, không nội suy.');
      ensure(typeof binding.dbSourceId === 'string' && binding.dbSourceId, 'Binding cần dbSourceId.');
      ensure(Array.isArray(binding.tables) && binding.tables.length && binding.tables.every(table => typeof table === 'string' && table.length <= 512 && /^[^\x00-\x1f.]+\.[^\x00-\x1f.]+$/.test(table)), 'Binding cần allowlist schema.table.');
      for (const [parameter, mapping] of Object.entries(binding.parameters || {})) {
        id(parameter); ensure(['string', 'number', 'integer', 'boolean', 'date'].includes(mapping.type), 'Mapping tham số không hợp lệ.');
        ensure(Object.hasOwn(mapping, 'slot') !== Object.hasOwn(mapping, 'value'), 'Tham số cần chọn slot hoặc giá trị tham chiếu.');
        if (Object.hasOwn(mapping, 'value')) { references(mapping.value, steps); continue; }
        ensure(template.inputs[mapping.slot], 'Mapping tham số không hợp lệ.');
        const schema = template.inputs[mapping.slot].schema;
        ensure(mapping.type === 'date' ? schema.type === 'string' && schema.format === 'date' : mapping.type === schema.type || (mapping.type === 'number' && schema.type === 'integer'), 'Kiểu tham số SQL phải khớp schema của slot.');
      }
      require('./sql').validateBinding(binding);
    }
    ensure(template.output && template.output.mapping, 'Thiếu output mapping.'); validateSchema(template.output.schema);
    if (template.output.presentation) {
      const presentation = template.output.presentation;
      ensure(Object.keys(presentation).every(key => ['labels', 'emptyText'].includes(key)), 'Presentation chứa trường chưa hỗ trợ.');
      if (presentation.labels) ensure(typeof presentation.labels === 'object' && !Array.isArray(presentation.labels) && Object.values(presentation.labels).every(label => typeof label === 'string' && label.length <= 200), 'Nhãn kết quả không hợp lệ.');
      if (presentation.emptyText !== undefined) ensure(typeof presentation.emptyText === 'string', 'emptyText cần chuỗi.');
    }
    references(template.output.mapping, steps);
    ensure(Array.isArray(template.fixtures) && template.fixtures.length, 'Cần fixture trước publish.');
    for (const fixture of template.fixtures) { ensure(fixture.input && Object.hasOwn(fixture, 'expected'), 'Fixture cần input/expected.'); ensure(validateInputs(template, fixture.input).valid, 'Fixture thiếu input hợp lệ.'); }
  }
  return bundle;
}
module.exports = { CAPABILITIES, OPERATORS, id, hash, get, resolve, condition, safeObject, validateSchema, validateValue, validateInputs, validatePackage, error, ensure };
