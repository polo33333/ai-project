'use strict';

const { dispatchToProvider } = require('../../intelligent_core/adapters');
const aiProviderManager = require('../../services/ai_provider_manager');
const securityGuard = require('../../intelligent_core/security_guard');
const dictionaryService = require('../../services/dictionary_service');
const { isLocalProvider } = require('./provider_classifier');
const { normalizeAssistantResponse } = require('./tool_call_normalizer');
const { validateToolCall } = require('./tool_argument_validator');
const { buildLocalMessages } = require('./local_prompt_builder');
const { compactToolResult } = require('./local_result_compactor');
const { getRequestPolicy, validateCallAgainstPolicy, hasSuccessfulTool, sanitizeFinalText } = require('./local_execution_policy');
const { emitProgress, toolLabel } = require('./progress_events');
const { trainingService } = require('../../training_core');

function fingerprint(name, args) {
  return `${name}:${JSON.stringify(args, Object.keys(args || {}).sort())}`;
}

function extractSql(text = '') {
  const raw = String(text).trim();
  const fenced = raw.match(/```(?:sql|tsql)?\s*([\s\S]*?)```/i);
  const unfenced = raw.match(/(?:^|\n)\s*((?:select|with)\b[\s\S]*)/i);
  const candidate = (fenced?.[1] || unfenced?.[1] || '').trim();
  return /^(?:select|with)\b/i.test(candidate) ? candidate : '';
}

function hasUsefulRows(call) {
  const rows = call?.result?.rows;
  if (!call?.success || !Array.isArray(rows) || rows.length === 0) return false;
  return rows.some(row => Object.values(row || {}).some(value => value !== null && value !== undefined && value !== ''));
}

function mentionsIdentifier(text, identifier) {
  const escaped = String(identifier || '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped) && new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'i').test(String(text || '').toLowerCase());
}

function getExplicitSchemaRefs(userMessage = '') {
  const question = String(userMessage).toLowerCase();
  const tables = dictionaryService.getGroupedTables().filter(table => mentionsIdentifier(question, table.tableName));
  const scopedTables = tables.length ? tables : dictionaryService.getGroupedTables();
  const columns = scopedTables.flatMap(table => table.columns
    .filter(column => mentionsIdentifier(question, column.columnName))
    .map(column => ({ ...column, tableName: table.tableName })));
  return { tables, columns };
}

function isBusinessSqlCall(call, refs = {}) {
  if (!hasUsefulRows(call)) return false;
  const sql = String(call.args?.sql || call.result?.sql || '');
  if (/\b(?:information_schema|sys\.(?:tables|columns|objects|schemas))\b/i.test(sql)) return false;
  if (refs.tables?.length && !refs.tables.some(table => new RegExp(`\\b${String(table.tableName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sql))) return false;
  const requiredColumns = [...new Set((refs.columns || []).map(column => column.columnName))];
  if (requiredColumns.some(column => !new RegExp(`\\b${String(column).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sql))) return false;
  return true;
}

const TABLE_PREFIX_PATTERN = new RegExp(`^${(process.env.LOCAL_MODEL_TABLE_PREFIX || 'T_').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
const DEFAULT_DATE_COLUMN_HINTS = (process.env.LOCAL_MODEL_DATE_COLUMN_HINTS || 'ToDate,PaymentDate,CreateDate')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);

function buildRequestedLatestMonthsSql(userMessage = '', months, selectedTables = []) {
  const refs = getExplicitSchemaRefs(userMessage);
  const selectedNames = selectedTables.map(table => String(table?.tableName || table).toLowerCase());
  const groupedTables = dictionaryService.getGroupedTables();
  const table = refs.tables[0] || selectedNames
    .map(name => groupedTables.find(candidate => String(candidate.tableName).toLowerCase() === name))
    .find(Boolean);
  if (!table || !months) return '';
  const numericTypes = /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i;
  const normalizedQuestion = String(userMessage).toLowerCase();
  const explicitTableColumns = table.columns.filter(column => mentionsIdentifier(normalizedQuestion, column.columnName));
  const metric = explicitTableColumns.find(column => numericTypes.test(column.dataType) && !/id$/i.test(column.columnName))
    || refs.columns.find(column => column.tableName === table.tableName && numericTypes.test(column.dataType) && !/id$/i.test(column.columnName));
  const dateColumns = table.columns.filter(column => /date|time/i.test(column.dataType));
  const preferredDateNames = [`${table.tableName.replace(TABLE_PREFIX_PATTERN, '')}Date`, ...DEFAULT_DATE_COLUMN_HINTS];
  const dateColumn = explicitTableColumns.find(column => dateColumns.includes(column))
    || preferredDateNames.map(name => dateColumns.find(column => column.columnName.toLowerCase() === name.toLowerCase())).find(Boolean)
    || dateColumns[0];
  if (!metric || !dateColumn) return '';
  return `SELECT TOP ${months} FORMAT([${dateColumn.columnName}], 'yyyy-MM') AS [Period], SUM([${metric.columnName}]) AS [${metric.columnName}] FROM [${table.tableName}] WHERE [${dateColumn.columnName}] IS NOT NULL GROUP BY FORMAT([${dateColumn.columnName}], 'yyyy-MM') ORDER BY [Period] DESC`;
}

function buildEntityLookupSql(userMessage = '', refs = {}) {
  // Generic "looked up by name" recovery: works for whatever table the user
  // already named in the message (see getExplicitSchemaRefs), instead of
  // being hardcoded to one entity/table. Trigger requires the literal word
  // "tên" (name) — e.g. "nhân viên tên Bình", "sản phẩm có tên là Táo",
  // "khách hàng tên Nguyễn Văn A" — so it stays specific enough not to fire
  // on unrelated questions that happen to mention a known table name.
  const table = refs.tables?.[0];
  if (!table) return '';

  const question = String(userMessage).trim();
  const nameMatch = question.match(/t[eê]n\s*(?:l[aà])?\s*[:"']?\s*(.+)$/iu);
  if (!nameMatch) return '';

  const searchTerm = nameMatch[1]
    .replace(/\s+(?:trong|thu[oộ]c|[oở])\s+(?:b[aả]ng\s+)?[\s\S]*$/iu, '')
    .replace(/[?.!,;:"']+$/g, '')
    .trim();
  if (!searchTerm || searchTerm.length > 100) return '';

  const isTextType = dataType => /char|text/i.test(String(dataType || ''));
  const nameColumn = table.columns.find(column => mentionsIdentifier(question, column.columnName) && isTextType(column.dataType))
    || table.columns.find(column => /name$/i.test(column.columnName) && isTextType(column.dataType))
    || table.columns.find(column => isTextType(column.dataType));
  if (!nameColumn) return '';

  const orderColumn = table.columns.find(column => new RegExp(`^${table.tableName}ID$`, 'i').test(column.columnName))
    || table.columns.find(column => /id$/i.test(column.columnName));

  const escapedTerm = searchTerm.replace(/'/g, "''");
  const orderClause = orderColumn ? ` ORDER BY [${orderColumn.columnName}]` : '';
  return `SELECT TOP 100 * FROM [${table.tableName}] WHERE [${nameColumn.columnName}] LIKE N'%${escapedTerm}%'${orderClause}`;
}

function buildPlannedTablePreviewSql(plan = {}) {
  if (!plan.table) return '';
  const table = dictionaryService.getGroupedTables().find(candidate => candidate.tableName === plan.table && candidate.isActive !== false);
  if (!table) return '';
  const columns = (table.columns || []).map(column => column.columnName).filter(Boolean).slice(0, 20);
  if (!columns.length) return '';
  const baseName = table.tableName.replace(/^[A-Z]+_/i, '');
  const preferredOrderNames = [`${baseName}Date`, 'CreateDate', 'UpdateDate'];
  const orderColumn = preferredOrderNames
    .map(name => table.columns.find(column => column.columnName.toLowerCase() === name.toLowerCase()))
    .find(Boolean)
    || table.columns.find(column => column.isPrimaryKey)
    || table.columns.find(column => /id$/i.test(column.columnName));
  const orderClause = orderColumn ? ` ORDER BY [${orderColumn.columnName}] DESC` : '';
  return `SELECT TOP 100 ${columns.map(column => `[${column}]`).join(', ')} FROM [${table.tableName}]${orderClause}`;
}

function buildLatestMonthsSql(toolCalls, months) {
  const sqlCalls = toolCalls.filter(call => call.toolName === 'execute_sql_query');
  for (const call of [...sqlCalls].reverse()) {
    const sql = String(call.args?.sql || call.result?.sql || '');
    const table = sql.match(/\bfrom\s+([\[\]\w.]+)/i)?.[1];
    const dateColumn = sql.match(/\bformat\s*\(\s*([\[\]\w.]+)\s*,\s*N?['"]yyyy[-/]MM['"]/i)?.[1]
      || sql.match(/\bwhere\s+([\[\]\w.]+)\s*(?:>=|>|between)/i)?.[1];
    const sum = [...sql.matchAll(/\bsum\s*\(\s*([\[\]\w.]+)\s*\)\s*(?:as\s+)?([\[\]\w]+)?/ig)][0];
    if (!table || !dateColumn || !sum?.[1]) continue;
    const metric = sum[1];
    const alias = String(sum[2] || 'TotalValue').replace(/[\[\]]/g, '');
    return `SELECT TOP ${months} FORMAT(${dateColumn}, 'yyyy-MM') AS Period, SUM(${metric}) AS [${alias}] FROM ${table} WHERE ${dateColumn} IS NOT NULL GROUP BY FORMAT(${dateColumn}, 'yyyy-MM') ORDER BY Period DESC`;
  }
  return '';
}

function buildChartArgs(rows, title = 'Biểu đồ dữ liệu') {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const columns = Object.keys(rows[0] || {});
  const numericColumns = columns.filter(column => rows.some(row => Number.isFinite(Number(row?.[column]))));
  if (!numericColumns.length) return null;
  const labelColumn = columns.find(column => !numericColumns.includes(column)) || columns[0];
  return {
    type: 'bar', title,
    labels: rows.map((row, index) => String(row?.[labelColumn] ?? index + 1)),
    datasets: numericColumns.filter(column => column !== labelColumn).map(column => ({
      label: column,
      data: rows.map(row => Number(row?.[column]) || 0)
    }))
  };
}

function repairInvalidColumnSql(toolCalls, userMessage = '') {
  const failed = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && !call.success && /invalid column name/i.test(call.error || ''));
  if (!failed) return '';
  const invalid = String(failed.error).match(/Invalid column name ['"]([^'"]+)['"]/i)?.[1];
  const sql = String(failed.args?.sql || '');
  if (!invalid || !sql) return '';
  const normalizedQuestion = String(userMessage).toLowerCase();
  const explicitColumns = dictionaryService.getDictionary().filter(column =>
    normalizedQuestion.includes(String(column.columnName).toLowerCase()) &&
    new RegExp(`\\bfrom\\s+(?:\\[[^\\]]+\\]\\.)?\\[?${String(column.tableName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?\\b`, 'i').test(sql)
  );
  const replacement = explicitColumns.find(column => column.columnName.toLowerCase() !== invalid.toLowerCase());
  if (!replacement) return '';
  return sql.replace(new RegExp(`\\b${invalid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), replacement.columnName);
}

function isUngroundedKnowledgeAnswer(text = '') {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  return /khong co thong tin(?: cu the)?|khong phai ung dung|neu co ung dung|app nao cu the|ung dung nao cu the|hay cho (?:toi|minh) biet them/.test(normalized);
}

function localCandidates(selected) {
  const allowCloud = process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK === 'true';
  return [selected, ...aiProviderManager.getProviders()
    .filter(candidate => candidate.id !== selected?.id)
    .filter(candidate => candidate.baseUrl && candidate.model && candidate.status !== 'unconfigured')
    .filter(candidate => allowCloud || isLocalProvider(candidate))
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))]
    .filter(Boolean);
}

function buildToolFallbackReply(toolCalls = []) {
  const successful = toolCalls.filter(call => call.success);
  if (!successful.length) return '';
  const last = successful[successful.length - 1];
  if (last.toolName === 'calculate_expression' && last.result?.value !== undefined) {
    return `Kết quả: **${last.args?.expression || ''} = ${last.result.value}**.`;
  }
  if (last.toolName === 'calculate_stats' && last.result) {
    return `Đã tính toán thống kê thành công: ${Object.entries(last.result).map(([key, value]) => `${key}: ${value}`).join(', ')}.`;
  }
  if (last.toolName === 'get_current_datetime' && last.result?.display) return last.result.display;
  if (last.toolName === 'execute_sql_query') {
    const count = last.result?.rowCount ?? last.result?.rows?.length ?? 0;
    return `Đã truy vấn dữ liệu thành công và tìm thấy **${count}** dòng kết quả.`;
  }
  if (last.toolName === 'search_schema') {
    const count = last.result?.totalMatched ?? last.result?.tables?.length ?? 0;
    return `Đã tìm thấy **${count}** bảng phù hợp trong schema.`;
  }
  if (last.toolName === 'search_knowledge_base') {
    const count = last.result?.totalResults ?? last.result?.documents?.length ?? 0;
    return `Đã tìm thấy **${count}** kết quả liên quan trong kho tri thức.`;
  }
  if (last.toolName === 'export_data' && last.result?.downloadUrl) return `Đã xuất file thành công: [Tải file tại đây](${last.result.downloadUrl}).`;
  return `Đã thực thi công cụ **${last.toolName}** thành công.`;
}

function ensureDownloadLink(text, downloadUrl) {
  const reply = String(text || '').trim();
  const url = String(downloadUrl || '').trim();
  if (!url) return reply;
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\[[^\\]]+\\]\\(\\s*${escapedUrl}\\s*\\)`, 'i').test(reply)) return reply;
  const link = `[Tải file tại đây](${url})`;
  const codeUrlPattern = new RegExp('`' + escapedUrl + '`', 'i');
  if (codeUrlPattern.test(reply)) return reply.replace(codeUrlPattern, link);
  const plainUrlPattern = new RegExp(escapedUrl, 'i');
  if (plainUrlPattern.test(reply)) return reply.replace(plainUrlPattern, link);
  return `${reply}\n\n${link}.`.trim();
}

function isInsufficientSqlAnswer(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return true;
  if (clean.replace(/\s+/g, '').length < 12) return true;
  if (extractSql(clean)) return true;
  const normalized = clean.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  return normalized.includes('da truy van du lieu thanh cong')
    && normalized.includes('dong ket qua')
    && !clean.includes('\n');
}

function normalizeForComparison(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/đ/g, 'd');
}

function isListRequest(text = '') {
  const normalized = normalizeForComparison(text);
  return /(^|\s)ds(?:\s|$)|danh sach|liet ke|chi tiet|cho (?:(?:toi|minh)\s+)?xem/.test(normalized);
}

function listAnswerMentionsRowValue(text = '', sqlCall = null) {
  const answer = normalizeForComparison(text);
  const rows = Array.isArray(sqlCall?.result?.rows) ? sqlCall.result.rows : [];
  if (!answer || !rows.length) return false;

  const meaningfulValues = rows.slice(0, 10).flatMap(row => Object.values(row || {}))
    .filter(value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean')
    .map(normalizeForComparison)
    .filter(value => value.length >= 3 && !/^(?:true|false|null)$/.test(value));

  // Prefer names, codes, addresses and other descriptive values over IDs/counts.
  if (meaningfulValues.length) return meaningfulValues.some(value => answer.includes(value));
  return Object.values(rows[0] || {}).some(value => answer.includes(normalizeForComparison(value)));
}

function markdownCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  const normalized = value instanceof Date ? value.toISOString() : String(value);
  return normalized.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function buildSqlRowsFallbackReply(sqlCall) {
  const rows = Array.isArray(sqlCall?.result?.rows) ? sqlCall.result.rows : [];
  if (!rows.length) return 'Không tìm thấy dữ liệu phù hợp.';

  const columns = Object.keys(rows[0] || {}).slice(0, 10);
  if (rows.length === 1) {
    const details = columns.map(column => `- **${markdownCell(column)}:** ${markdownCell(rows[0]?.[column])}`).join('\n');
    return `Tìm thấy **1** dòng kết quả:\n\n${details}`;
  }

  const visibleRows = rows.slice(0, 10);
  const header = `| ${columns.map(markdownCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = visibleRows.map(row => `| ${columns.map(column => markdownCell(row?.[column])).join(' | ')} |`).join('\n');
  const remainder = rows.length > visibleRows.length ? `\n\nHiển thị ${visibleRows.length}/${rows.length} kết quả.` : '';
  return `Tìm thấy **${rows.length}** kết quả:\n\n${header}\n${separator}\n${body}${remainder}`;
}

class LocalModelHarness {
  constructor({ toolManager, maxIterations, maxRepairs, dispatch = dispatchToProvider } = {}) {
    this.toolManager = toolManager;
    this.maxIterations = maxIterations || Number(process.env.LOCAL_MODEL_MAX_ITERATIONS || 7);
    this.maxRepairs = maxRepairs ?? Number(process.env.LOCAL_MODEL_MAX_REPAIRS || 1);
    this.dispatch = dispatch;
  }

  async _dispatch(provider, candidates, messages, tools, trace, collectUsage, externalSignal = null) {
    let lastError;
    for (const candidate of [provider, ...candidates.filter(item => item.id !== provider?.id)]) {
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
      const timeoutMs = Number(process.env.AI_LOCAL_TIMEOUT_MS || process.env.AI_DEFAULT_TIMEOUT_MS);
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
      try {
        const response = await this.dispatch(candidate, messages, tools, controller.signal);
        collectUsage(response?.usage);
        if (candidate.id !== provider?.id) trace.providerFallbacks.push({
          fromProviderId: provider?.id || null,
          toProviderId: candidate.id,
          toProviderName: candidate.name,
          reason: lastError?.message || 'Local provider unavailable',
          timestamp: new Date().toISOString()
        });
        return { response, provider: candidate };
      } catch (error) {
        lastError = error;
        if (externalSignal?.aborted || error?.name === 'AbortError') throw error;
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', abortFromCaller);
      }
    }
    throw lastError || new Error('No local model provider is available.');
  }

  async run({ userMessage = '', messages = [], provider, enabledToolNames = null, context = {}, onProgress = null }) {
    const throwIfAborted = () => {
      if (context.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    };
    throwIfAborted();
    let activeProvider = provider || aiProviderManager.getActiveProvider();
    const candidates = localCandidates(activeProvider);
    const toolContext = { ...context, allowedToolNames: enabledToolNames };
    const toolDefs = this.toolManager ? this.toolManager.getToolDefinitions(toolContext) : [];
    const effectiveUserMessage = userMessage || [...messages].reverse().find(message => message.role === 'user')?.content || '';
    const inferredPolicy = getRequestPolicy(effectiveUserMessage);
    // Web-grounded "bao nhiêu" questions are not requests for records from
    // the configured business database. SQL tools are intentionally disabled
    // for Web Search, so do not discard a valid web answer for missing SQL.
    const requestPolicy = context.webSearch
      ? { ...inferredPolicy, chartRequired: false, exportRequired: false, dataRequired: false, temporalMonths: null }
      : inferredPolicy;
    const explicitSchemaRefs = getExplicitSchemaRefs(effectiveUserMessage);
    const requestPlan = context.requestPlan || trainingService.plan({ question: effectiveUserMessage, selectedTables: context.selectedTables || [] });
    const isQualifiedBusinessSqlCall = call => isBusinessSqlCall(call, explicitSchemaRefs)
      && trainingService.evaluateSql(call.args?.sql || call.result?.sql || '', requestPlan).valid;
    const knowledgeGrounding = context.knowledgeGrounding;
    const conversation = buildLocalMessages(messages, toolDefs, requestPolicy);
    const trace = {
      harness: 'local', startTime: Date.now(), iterations: 0, steps: [], toolCalls: [], providerFallbacks: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false },
      training: { plan: requestPlan, sqlEvaluations: [] },
      memoryDecision: context.memoryDecision ? { ...context.memoryDecision, fallbackHistory: undefined, accountId: undefined } : null
    };
    const collectUsage = usage => {
      if (!usage) return;
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      trace.tokenUsage.inputTokens += input;
      trace.tokenUsage.outputTokens += output;
      trace.tokenUsage.totalTokens += Number(usage.totalTokens) || input + output;
      trace.tokenUsage.calls += 1;
      trace.tokenUsage.available = true;
    };
    const seen = new Set();
    const toolCalls = [];
    let repairs = 0;
    let finalText = null;
    let forceSynthesis = false;
    let lastDispatchError = null;
    const toolEnabled = name => !Array.isArray(enabledToolNames) || enabledToolNames.includes(name);
    const executeDeterministicTool = async (name, args, reason) => {
      throwIfAborted();
      if (!this.toolManager || !toolEnabled(name)) return null;
      if (name === 'execute_sql_query') {
        const structuralValidation = validateCallAgainstPolicy({ name }, args, requestPolicy, []);
        const sqlEvaluation = trainingService.evaluateSql(args.sql, requestPlan);
        const violatesPlannedTable = sqlEvaluation.violations.some(violation => violation === 'WRONG_TABLE' || violation === 'SCHEMA_QUERY');
        const referencesWrongData = explicitSchemaRefs.tables.length > 0 && !explicitSchemaRefs.tables.some(table =>
          new RegExp(`\\b${String(table.tableName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(args.sql || ''))
        );
        const metadataQuery = /\b(?:information_schema|sys\.(?:tables|columns|objects|schemas))\b/i.test(String(args.sql || ''));
        if (!structuralValidation.valid || violatesPlannedTable || referencesWrongData || metadataQuery) {
          trace.steps.push({ type: 'DETERMINISTIC_SQL_REJECTED', toolName: name, reason, error: structuralValidation.error || `SQL does not match the planned table ${requestPlan.table || ''}.`.trim() });
          return null;
        }
      }
      emitProgress(onProgress, { type: 'tool_started', label: toolLabel(name), status: 'running', icon: name === 'execute_sql_query' ? 'database' : name === 'render_chart' ? 'chart-column' : 'gear', toolName: name });
      const execution = await this.toolManager.executeTool(name, args, context);
      throwIfAborted();
      const log = { toolName: name, args, success: execution.success, result: execution.result || null, error: execution.error || null, durationMs: execution.durationMs };
      toolCalls.push(log);
      if (name === 'execute_sql_query') trace.training.sqlEvaluations.push(trainingService.evaluateSql(args.sql, requestPlan));
      trace.toolCalls.push({ toolName: name, args, success: execution.success, durationMs: execution.durationMs, source: 'deterministic_harness' });
      trace.steps.push({ type: reason, toolName: name, success: execution.success });
      emitProgress(onProgress, { type: 'tool_completed', label: execution.success ? toolLabel(name, 'done', execution.result?.rowCount ?? execution.result?.rows?.length) : `${name} gặp lỗi`, status: execution.success ? 'done' : 'error', icon: execution.success ? 'check' : 'xmark', toolName: name, rowCount: execution.result?.rowCount ?? execution.result?.rows?.length, durationMs: execution.durationMs });
      return log;
    };

    while (trace.iterations < this.maxIterations) {
      trace.iterations += 1;
      emitProgress(onProgress, { type: 'model_started', label: `Model đang phân tích · vòng ${trace.iterations}`, status: 'running', icon: 'brain', iteration: trace.iterations, providerName: activeProvider?.name });
      let dispatched;
      try {
        dispatched = await this._dispatch(activeProvider, candidates, conversation, toolDefs, trace, collectUsage, context.signal);
      } catch (error) {
        trace.steps.push({ iteration: trace.iterations, type: 'DISPATCH_ERROR', error: error.message });
        lastDispatchError = error;
        if (context.signal?.aborted || error?.name === 'AbortError') throw error;
        if (toolCalls.length === 0) throw error;
        forceSynthesis = true;
        break;
      }
      activeProvider = dispatched.provider;
      emitProgress(onProgress, { type: 'model_completed', label: `Model đã hoàn thành vòng ${trace.iterations}`, status: 'done', icon: 'robot', iteration: trace.iterations, providerName: activeProvider?.name });
      const normalized = normalizeAssistantResponse(dispatched.response);

      if (normalized.kind === 'final') {
        conversation.push({ role: 'assistant', content: dispatched.response.content || '' });
        finalText = String(normalized.content || '').trim();
        if (knowledgeGrounding?.required && isUngroundedKnowledgeAnswer(finalText) && trace.iterations < this.maxIterations) {
          trace.steps.push({ iteration: trace.iterations, type: 'UNGROUNDED_KNOWLEDGE_RESPONSE' });
          finalText = null;
          emitProgress(onProgress, { type: 'grounding_retry', label: 'Câu trả lời chưa bám tài liệu, đang tổng hợp lại', status: 'warning', icon: 'book-open', iteration: trace.iterations });
          conversation.push({
            role: 'user',
            content: `Câu trả lời vừa rồi đã bỏ qua nguồn được chọn. Hãy trả lời trực tiếp câu hỏi từ nội dung tài liệu sau, nêu chính xác thông tin hữu ích như tên ứng dụng hoặc liên kết nếu có, và ghi nguồn ${knowledgeGrounding.sourceTitles?.join(', ') || 'đã chọn'}:\n\n${String(knowledgeGrounding.documentContext || '').slice(0, 12000)}`
          });
          continue;
        }
        const missingData = requestPolicy.dataRequired
          && !toolCalls.some(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
        if (missingData && trace.iterations < this.maxIterations) {
          trace.steps.push({ iteration: trace.iterations, type: 'INCOMPLETE_DATA_RESPONSE' });
          finalText = null;
          emitProgress(onProgress, { type: 'incomplete_response', label: 'Câu trả lời chưa có dữ liệu thực tế, đang truy vấn', status: 'warning', icon: 'triangle-exclamation', iteration: trace.iterations });
          conversation.push({
            role: 'user',
            content: 'The answer is incomplete. The user requested actual business records, not schema metadata. Call execute_sql_query now, filter by the specific name or criteria in the request, and answer only from returned rows.'
          });
          continue;
        }
        const missingChart = requestPolicy.chartRequired && !hasSuccessfulTool(toolCalls, 'render_chart');
        if (missingChart && trace.iterations < this.maxIterations) {
          trace.steps.push({ iteration: trace.iterations, type: 'INCOMPLETE_CHART_RESPONSE' });
          finalText = null;
          emitProgress(onProgress, { type: 'incomplete_response', label: 'Câu trả lời chưa có biểu đồ, đang tiếp tục xử lý', status: 'warning', icon: 'triangle-exclamation', iteration: trace.iterations });
          conversation.push({ role: 'user', content: hasSuccessfulTool(toolCalls, 'execute_sql_query')
            ? 'The answer is incomplete. Use the existing SQL rows to call render_chart now. Do not write an image URL.'
            : requestPolicy.temporalMonths
              ? 'The answer is incomplete. Call execute_sql_query with monthly aggregation, then call render_chart.'
              : 'The answer is incomplete. Call execute_sql_query to fetch the data needed for the chart, then call render_chart.' });
          continue;
        }
        trace.steps.push({ iteration: trace.iterations, type: finalText ? 'final_answer' : 'EMPTY_MODEL_RESPONSE' });
        if (!finalText && toolCalls.length) {
          finalText = null;
          forceSynthesis = true;
        }
        break;
      }

      const call = normalized.calls[0];
      const canonicalToolCall = call ? [{
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) }
      }] : [];
      conversation.push({ role: 'assistant', content: '', tool_calls: canonicalToolCall });
      const validation = validateToolCall(this.toolManager, call, enabledToolNames);
      if (!validation.valid) {
        trace.steps.push({ iteration: trace.iterations, type: validation.category, toolName: call?.name, errors: validation.errors });
        emitProgress(onProgress, { type: 'tool_repair', label: `Tool call chưa hợp lệ, đang yêu cầu model điều chỉnh`, status: 'warning', icon: 'wrench', iteration: trace.iterations, toolName: call?.name });
        if (repairs >= this.maxRepairs) {
          if (call) {
            conversation.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: JSON.stringify({ success: false, error: `Tool call rejected: ${validation.errors.join(' ')}` })
            });
          }
          forceSynthesis = true;
          break;
        }
        repairs += 1;
        if (call) {
          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ success: false, error: `Tool call rejected: ${validation.errors.join(' ')}` })
          });
        }
        conversation.push({ role: 'user', content: `Tool call rejected: ${validation.errors.join(' ')} Return one corrected tool call using the declared schema, or answer without a tool.` });
        continue;
      }

      const fp = fingerprint(call.name, validation.args);
      if (seen.has(fp)) {
        trace.steps.push({ iteration: trace.iterations, type: 'NO_PROGRESS', toolName: call.name });
        conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ success: false, error: 'Repeated identical call. Do not call it again; answer from the previous result.' }) });
        forceSynthesis = true;
        emitProgress(onProgress, { type: 'no_progress', label: `Phát hiện gọi lặp ${call.name}, đang dừng vòng lặp`, status: 'warning', icon: 'rotate', iteration: trace.iterations, toolName: call.name });
        break;
      }
      seen.add(fp);

      const policyValidation = validateCallAgainstPolicy(call, validation.args, requestPolicy, toolCalls);
      if (!policyValidation.valid) {
        trace.steps.push({
          iteration: trace.iterations, type: policyValidation.category, toolName: call.name,
          sql: call.name === 'execute_sql_query' ? securityGuard.maskSensitiveData(String(validation.args.sql || '')) : undefined,
          error: policyValidation.error
        });
        conversation.push({
          role: 'tool', tool_call_id: call.id, name: call.name,
          content: JSON.stringify({ success: false, error: policyValidation.error })
        });
        emitProgress(onProgress, { type: 'policy_repair', label: policyValidation.category === 'TEMPORAL_SQL_POLICY' ? 'SQL chưa tổng hợp đúng theo tháng, đang điều chỉnh' : 'Đã đạt giới hạn truy vấn SQL, chuyển sang bước tiếp theo', status: 'warning', icon: 'shield-halved', iteration: trace.iterations, toolName: call.name });
        continue;
      }

      if (call.name === 'execute_sql_query') {
        const sqlEvaluation = trainingService.evaluateSql(validation.args.sql, requestPlan);
        trace.training.sqlEvaluations.push(sqlEvaluation);
        const blockingViolation = sqlEvaluation.violations.find(violation => violation === 'WRONG_TABLE' || violation === 'SCHEMA_QUERY');
        if (blockingViolation) {
          const expectedTable = requestPlan.table || 'the highest-ranked business table';
          const error = blockingViolation === 'WRONG_TABLE'
            ? `SQL queries the wrong business table. Use ${expectedTable} for the current request.`
            : 'Schema metadata is not business data. Query the selected business table.';
          trace.steps.push({ iteration: trace.iterations, type: blockingViolation, toolName: call.name, error });
          conversation.push({
            role: 'tool', tool_call_id: call.id, name: call.name,
            content: JSON.stringify({ success: false, error, expectedTable })
          });
          emitProgress(onProgress, { type: 'policy_repair', label: 'SQL chọn sai bảng, đang điều chỉnh', status: 'warning', icon: 'wrench', iteration: trace.iterations, toolName: call.name });
          continue;
        }
      }

      if (['render_chart', 'export_data'].includes(call.name) && requestPolicy.dataRequired && !toolCalls.some(item => item.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(item))) {
        const error = `${call.name} bị từ chối: chưa có kết quả SQL nghiệp vụ hợp lệ để sử dụng.`;
        trace.steps.push({ iteration: trace.iterations, type: 'PREMATURE_OUTPUT_TOOL', toolName: call.name, error });
        conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ success: false, error }) });
        emitProgress(onProgress, { type: 'policy_repair', label: 'Chưa có dữ liệu nghiệp vụ hợp lệ, đang sửa truy vấn', status: 'warning', icon: 'shield-halved', iteration: trace.iterations, toolName: call.name });
        continue;
      }

      emitProgress(onProgress, { type: 'tool_started', label: toolLabel(call.name), status: 'running', icon: call.name === 'execute_sql_query' ? 'database' : call.name === 'render_chart' ? 'chart-column' : 'gear', iteration: trace.iterations, toolName: call.name });
      const execution = await this.toolManager.executeTool(call.name, validation.args, context);
      throwIfAborted();
      const log = { toolName: call.name, args: validation.args, success: execution.success, result: execution.result || null, error: execution.error || null, durationMs: execution.durationMs };
      toolCalls.push(log);
      if (call.name === 'execute_sql_query' && !trace.training.sqlEvaluations.length) trace.training.sqlEvaluations.push(trainingService.evaluateSql(validation.args.sql, requestPlan));
      trace.toolCalls.push({ toolName: call.name, args: validation.args, success: execution.success, durationMs: execution.durationMs, source: call.source });
      trace.steps.push({ iteration: trace.iterations, type: 'tool_call', toolName: call.name, success: execution.success });
      emitProgress(onProgress, {
        type: 'tool_completed', label: execution.success ? toolLabel(call.name, 'done', execution.result?.rowCount ?? execution.result?.rows?.length) : `${call.name} gặp lỗi, model sẽ điều chỉnh`,
        status: execution.success ? 'done' : 'error', icon: execution.success ? 'check' : 'xmark', iteration: trace.iterations,
        toolName: call.name, rowCount: execution.result?.rowCount ?? execution.result?.rows?.length, durationMs: execution.durationMs
      });
      conversation.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: compactToolResult(execution) });
      if (call.name === 'execute_sql_query' && execution.success && !hasUsefulRows(log) && requestPolicy.temporalMonths) {
        conversation.push({ role: 'user', content: `The query returned no usable rows. “Latest ${requestPolicy.temporalMonths} months” means the latest months present in the table, not months relative to today's date. Query the latest available monthly buckets.` });
      }
    }

    // Small local models often print valid SQL instead of invoking it. Execute that SQL safely.
    throwIfAborted();
    if (requestPolicy.dataRequired && !toolCalls.some(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call))) {
      const printedSql = extractSql(finalText || '');
      if (printedSql) {
        const printedExecution = await executeDeterministicTool('execute_sql_query', { sql: printedSql }, 'EXECUTED_PRINTED_SQL');
        if (!printedExecution) finalText = null;
      }
    }

    // Recover temporal queries that incorrectly anchored to the current system date.
    let usefulSql = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
    if (!usefulSql) {
      const repairedSql = repairInvalidColumnSql(toolCalls, effectiveUserMessage);
      if (repairedSql) {
        await executeDeterministicTool('execute_sql_query', { sql: repairedSql }, 'INVALID_COLUMN_RECOVERY');
        usefulSql = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
      }
    }
    let entityLookupAttempted = false;
    if (!usefulSql && requestPolicy.dataRequired) {
      const plannedTable = requestPlan.table
        ? dictionaryService.getGroupedTables().find(table => table.tableName === requestPlan.table)
        : null;
      const lookupRefs = explicitSchemaRefs.tables.length
        ? explicitSchemaRefs
        : { ...explicitSchemaRefs, tables: plannedTable ? [plannedTable] : [] };
      const entityLookupSql = buildEntityLookupSql(effectiveUserMessage, lookupRefs);
      if (entityLookupSql) {
        entityLookupAttempted = true;
        await executeDeterministicTool('execute_sql_query', { sql: entityLookupSql }, 'ENTITY_LOOKUP_RECOVERY');
        usefulSql = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
      }
    }
    if (!usefulSql && requestPolicy.dataRequired && !entityLookupAttempted) {
      const previewSql = buildPlannedTablePreviewSql(requestPlan);
      if (previewSql) {
        await executeDeterministicTool('execute_sql_query', { sql: previewSql }, 'PLANNED_TABLE_RECOVERY');
        usefulSql = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
      }
    }
    if (!usefulSql && requestPolicy.temporalMonths) {
      const recoverySql = buildRequestedLatestMonthsSql(effectiveUserMessage, requestPolicy.temporalMonths, context.selectedTables || [])
        || buildLatestMonthsSql(toolCalls, requestPolicy.temporalMonths);
      if (recoverySql) {
        await executeDeterministicTool('execute_sql_query', { sql: recoverySql }, 'LATEST_DATA_MONTHS_RECOVERY');
        usefulSql = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call));
      }
    }

    // Chart and export are mechanical transformations; do them in the harness if the model omitted them.
    if (usefulSql && requestPolicy.chartRequired && !hasSuccessfulTool(toolCalls, 'render_chart')) {
      const chartArgs = buildChartArgs(usefulSql.result.rows, effectiveUserMessage.slice(0, 120));
      if (chartArgs?.datasets?.length) await executeDeterministicTool('render_chart', chartArgs, 'AUTO_RENDER_CHART');
    }
    if (usefulSql && requestPolicy.exportRequired && !hasSuccessfulTool(toolCalls, 'export_data')) {
      await executeDeterministicTool('export_data', { data: usefulSql.result.rows, format: 'xlsx', filename: `Bao_cao_${Date.now()}` }, 'AUTO_EXPORT_DATA');
    }

    const dataRecoveryCompleted = trace.steps.some(step => [
      'EXECUTED_PRINTED_SQL',
      'INVALID_COLUMN_RECOVERY',
      'ENTITY_LOOKUP_RECOVERY',
      'LATEST_DATA_MONTHS_RECOVERY'
    ].includes(step.type) && step.success);
    if (dataRecoveryCompleted) finalText = null;

    const chartComplete = !requestPolicy.chartRequired || hasSuccessfulTool(toolCalls, 'render_chart');
    const listAnswerMissingData = isListRequest(effectiveUserMessage)
      && usefulSql
      && !listAnswerMentionsRowValue(finalText, usefulSql);
    if ((isInsufficientSqlAnswer(finalText) || listAnswerMissingData) && usefulSql && chartComplete && (toolCalls.length || forceSynthesis)) {
      try {
        emitProgress(onProgress, { type: 'synthesis_started', label: 'Đang tổng hợp câu trả lời', status: 'running', icon: 'pen', providerName: activeProvider?.name });
        const synthesisData = compactToolResult({
          success: true,
          result: { rows: usefulSql.result?.rows || [], rowCount: usefulSql.result?.rowCount }
        });
        const exportCallForSynthesis = [...toolCalls].reverse().find(call => call.toolName === 'export_data' && call.success);
        const synthesisConversation = [
          { role: 'system', content: 'Synthesize a grounded final answer using only the current request context supplied below.' },
          { role: 'user', content: [
            'Answer ONLY the current request below. Ignore unrelated subjects from earlier conversation history.',
            `CURRENT REQUEST: ${JSON.stringify(effectiveUserMessage)}`,
            `CURRENT PLAN: ${JSON.stringify(requestPlan)}`,
            `CURRENT SQL DATA: ${synthesisData}`,
            `CHART STATUS: ${hasSuccessfulTool(toolCalls, 'render_chart') ? 'created' : 'not_created'}`,
            `EXPORT URL: ${JSON.stringify(exportCallForSynthesis?.result?.downloadUrl || null)}`,
            'Use only CURRENT SQL DATA. State the actual important values, not only the row count.',
            'For multiple rows, use a concise Markdown table. For one row, list its non-empty fields.',
            'Do not mention earlier employees or other previous topics unless CURRENT REQUEST explicitly asks for them.',
            'Do not describe the schema and do not call another tool.'
          ].join('\n')
          }
        ];
        const synthesis = await this._dispatch(activeProvider, candidates, synthesisConversation, [], trace, collectUsage, context.signal);
        activeProvider = synthesis.provider;
        finalText = sanitizeFinalText(synthesis.response.content || '', hasSuccessfulTool(toolCalls, 'render_chart'));
      } catch (error) {
        if (context.signal?.aborted || error?.name === 'AbortError') throw error;
        lastDispatchError = error;
        trace.steps.push({ type: 'FINAL_SYNTHESIS_ERROR', error: error.message });
      }
    }

    if (usefulSql && (isInsufficientSqlAnswer(finalText)
      || (isListRequest(effectiveUserMessage) && !listAnswerMentionsRowValue(finalText, usefulSql)))) {
      finalText = buildSqlRowsFallbackReply(usefulSql);
      trace.steps.push({ type: 'DETERMINISTIC_SQL_ROWS_FALLBACK' });
    }
    if (!String(finalText || '').trim()) {
      finalText = requestPolicy.chartRequired && !hasSuccessfulTool(toolCalls, 'render_chart')
        ? (hasSuccessfulTool(toolCalls, 'execute_sql_query')
            ? 'Đã truy vấn được dữ liệu nhưng chưa thể tạo biểu đồ hợp lệ. Vui lòng thử lại; hệ thống sẽ không hiển thị biểu đồ giả.'
            : 'Chưa thể truy vấn đủ dữ liệu để tạo biểu đồ.')
        : buildToolFallbackReply(toolCalls);
      if (finalText) trace.steps.push({ type: 'DETERMINISTIC_TOOL_FALLBACK' });
    }
    const exportCall = [...toolCalls].reverse().find(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
    if (requestPolicy.exportRequired && exportCall) finalText = ensureDownloadLink(finalText, exportCall.result.downloadUrl);
    if (!String(finalText || '').trim()) throw lastDispatchError || new Error('Local model returned an empty response.');
    finalText = sanitizeFinalText(finalText, hasSuccessfulTool(toolCalls, 'render_chart'));
    const responseEvaluation = trainingService.evaluateResponse({ reply: finalText, plan: requestPlan, toolCalls });
    trace.training.responseEvaluation = responseEvaluation;
    const requirementState = {
      data: !requestPolicy.dataRequired || toolCalls.some(call => call.toolName === 'execute_sql_query' && isQualifiedBusinessSqlCall(call)),
      chart: !requestPolicy.chartRequired || hasSuccessfulTool(toolCalls, 'render_chart'),
      export: !requestPolicy.exportRequired || hasSuccessfulTool(toolCalls, 'export_data'),
      knowledge: !knowledgeGrounding?.required || !isUngroundedKnowledgeAnswer(finalText),
      training: responseEvaluation.valid
    };
    trace.requirements = requirementState;
    trace.completionStatus = Object.values(requirementState).every(Boolean) ? 'SUCCESS' : 'PARTIAL';
    emitProgress(onProgress, { type: 'request_completed', label: 'Đã hoàn thành câu trả lời', status: 'done', icon: 'check', durationMs: Date.now() - trace.startTime });

    trace.durationMs = Date.now() - trace.startTime;
    return {
      replyText: securityGuard.maskSensitiveData(finalText || ''),
      toolCalls,
      usedProvider: activeProvider,
      providerFallbacks: trace.providerFallbacks,
      tokenUsage: trace.tokenUsage,
      trace,
      conversation
    };
  }
}

module.exports = LocalModelHarness;
module.exports.buildToolFallbackReply = buildToolFallbackReply;
module.exports.extractSql = extractSql;
module.exports.buildLatestMonthsSql = buildLatestMonthsSql;
module.exports.buildChartArgs = buildChartArgs;
module.exports.repairInvalidColumnSql = repairInvalidColumnSql;
module.exports.isBusinessSqlCall = isBusinessSqlCall;
module.exports.buildRequestedLatestMonthsSql = buildRequestedLatestMonthsSql;
module.exports.buildEntityLookupSql = buildEntityLookupSql;
module.exports.buildPlannedTablePreviewSql = buildPlannedTablePreviewSql;
// Backward-compat alias: old name/signature is gone (now takes `refs` too),
// keep this so any external import of the old name doesn't crash on require.
module.exports.buildEmployeeLookupSql = buildEntityLookupSql;
module.exports.isUngroundedKnowledgeAnswer = isUngroundedKnowledgeAnswer;
module.exports.isInsufficientSqlAnswer = isInsufficientSqlAnswer;
module.exports.isListRequest = isListRequest;
module.exports.listAnswerMentionsRowValue = listAnswerMentionsRowValue;
module.exports.buildSqlRowsFallbackReply = buildSqlRowsFallbackReply;
module.exports.ensureDownloadLink = ensureDownloadLink;
