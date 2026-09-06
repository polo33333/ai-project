const BaseStep = require('./base_step');
const { ExecuteSqlTool, ExportDataTool } = require('../tools/builtins');

function getPath(value, path) {
  return String(path || '').split('.').filter(Boolean).reduce((current, key) => current?.[key], value);
}

function resolve(value, state) {
  if (Array.isArray(value)) return value.map(item => resolve(item, state));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, state)]));
  }
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (exact) return getPath(state, exact[1].trim());
  return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path) => String(getPath(state, path.trim()) ?? ''));
}

class ConfiguredStep extends BaseStep {
  constructor(definition) {
    super({ id: definition.id, name: definition.name || definition.id, description: definition.description });
    this.config = definition.config || {};
    this.retry = definition.retry || null;
  }
}

class HttpRequestStep extends ConfiguredStep {
  async execute(state) {
    const url = resolve(this.config.url, state);
    if (!/^https?:\/\//i.test(url || '')) throw new Error('HTTP step requires a valid http(s) URL');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(this.config.timeoutMs || 30000)));
    try {
      const response = await fetch(url, {
        method: String(this.config.method || 'GET').toUpperCase(),
        headers: resolve(this.config.headers || {}, state),
        body: ['GET', 'HEAD'].includes(String(this.config.method || 'GET').toUpperCase())
          ? undefined : JSON.stringify(resolve(this.config.body || {}, state)),
        signal: controller.signal
      });
      const text = await response.text();
      let data = text;
      try { data = JSON.parse(text); } catch (_) {}
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${String(text).slice(0, 300)}`);
      return { [this.config.outputKey || this.id]: { status: response.status, data } };
    } finally { clearTimeout(timer); }
  }
}

class ConditionStep extends ConfiguredStep {
  async execute(state) {
    const left = resolve(this.config.left, state);
    const right = resolve(this.config.right, state);
    const operators = {
      equals: () => left === right,
      notEquals: () => left !== right,
      greaterThan: () => Number(left) > Number(right),
      lessThan: () => Number(left) < Number(right),
      contains: () => String(left ?? '').includes(String(right ?? '')),
      exists: () => left !== undefined && left !== null
    };
    const operation = operators[this.config.operator || 'equals'];
    if (!operation) throw new Error(`Unsupported condition operator: ${this.config.operator}`);
    return { [this.config.outputKey || this.id]: operation() };
  }
}

class TransformStep extends ConfiguredStep {
  async execute(state) {
    const mapping = this.config.mapping || {};
    return { [this.config.outputKey || this.id]: resolve(mapping, state) };
  }
}

class DelayStep extends ConfiguredStep {
  async execute() {
    const delayMs = Math.min(60000, Math.max(0, Number(this.config.delayMs || 0)));
    await new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
    return { [this.config.outputKey || this.id]: { delayedMs: delayMs } };
  }
}

class SqlStep extends ConfiguredStep {
  constructor(definition) { super(definition); this.tool = new ExecuteSqlTool(); }
  async execute(state, context) {
    const result = await this.tool.execute({ sql: resolve(this.config.sql, state) }, context);
    if (!result.success) throw new Error(result.error);
    return { [this.config.outputKey || this.id]: result.result };
  }
}

class ExportStep extends ConfiguredStep {
  constructor(definition) { super(definition); this.tool = new ExportDataTool(); }
  async execute(state, context) {
    const result = await this.tool.execute({
      data: resolve(this.config.data, state),
      format: resolve(this.config.format || 'xlsx', state),
      filename: resolve(this.config.filename || 'Automation_Export', state)
    }, context);
    if (!result.success) throw new Error(result.error);
    return { [this.config.outputKey || this.id]: result.result };
  }
}

const STEP_TYPES = { http: HttpRequestStep, condition: ConditionStep, transform: TransformStep, delay: DelayStep, sql: SqlStep, export: ExportStep };

function createStep(definition) {
  const StepClass = STEP_TYPES[definition?.type];
  if (!StepClass) throw new Error(`Unsupported workflow step type: ${definition?.type}`);
  if (!definition.id) throw new Error('Workflow step id is required');
  return new StepClass(definition);
}

module.exports = { createStep, resolve, STEP_TYPES };
