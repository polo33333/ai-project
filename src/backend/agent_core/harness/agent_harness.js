/**
 * AgentHarness — Điều phối Agentic Loop V2
 * Tích hợp đầy đủ:
 * 1. Provider Fallback an toàn (chỉ fallback lỗi recoverable: timeout, 5xx, rate limit)
 * 2. Token Collector gom toàn bộ usage
 * 3. Self-healing SQL có retry budget (<= 2) và fingerprint deduplication
 * 4. Trace Timeline chi tiết & Security Masking
 * 5. Final Synthesis call khi hết iteration mà đã có kết quả Tool
 */

const { dispatchToProvider } = require('../../intelligent_core/adapters');
const aiProviderManager = require('../../services/ai_provider_manager');
const securityGuard = require('../../intelligent_core/security_guard');
const errorRecovery = require('./error_recovery');
const { emitProgress, toolLabel } = require('./progress_events');
const { isLocalProvider } = require('./provider_classifier');

const REQUEST_TIMEOUT_MS = parseInt(process.env.AI_DEFAULT_TIMEOUT_MS || '30000', 10);
const LOCAL_REQUEST_TIMEOUT_MS = parseInt(process.env.AI_LOCAL_TIMEOUT_MS || process.env.AI_DEFAULT_TIMEOUT_MS, 10);

function providerTimeoutMs(provider) {
  return isLocalProvider(provider) ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

function getProviderCandidates(selectedProvider) {
  const fallbacks = aiProviderManager.getProviders()
    .filter(candidate => candidate.id !== selectedProvider?.id)
    .filter(candidate => candidate.baseUrl && candidate.model && candidate.status !== 'unconfigured')
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999));
  return [selectedProvider, ...fallbacks].filter(Boolean);
}

function isRecoverableProviderError(error) {
  if (!error) return false;
  const msg = String(error.message || '').toLowerCase();
  const status = error.status || error.statusCode || 0;

  // Lỗi mạng, timeout, rate limit, server error 5xx -> Cho phép fallback
  if (status >= 500 || status === 429) return true;
  if (msg.includes('timeout') || msg.includes('aborterror') || msg.includes('econnrefused') || msg.includes('fetch failed')) return true;
  if (msg.includes('rate limit') || msg.includes('overloaded') || msg.includes('quota')) return true;

  // Lỗi 400 Bad Request, 401 Unauthorized, context length exceeded -> Không fallback mù quáng
  return false;
}

async function dispatchWithProviderFallback(currentProvider, candidates, messages, tools, fallbackLog, collectUsage, externalSignal = null) {
  const ordered = [currentProvider, ...candidates.filter(candidate => candidate.id !== currentProvider?.id)];
  let lastError = null;

  for (const candidate of ordered) {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutMs = providerTimeoutMs(candidate);
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await dispatchToProvider(candidate, messages, tools, controller.signal);
      if (collectUsage && response?.usage) {
        collectUsage(response.usage);
      }
      if (candidate.id !== currentProvider?.id) {
        fallbackLog.push({
          fromProviderId: currentProvider?.id || null,
          toProviderId: candidate.id,
          toProviderName: candidate.name,
          reason: lastError?.message || 'Provider unavailable',
          timestamp: new Date().toISOString()
        });
      }
      return { response, provider: candidate };
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || error?.name === 'AbortError') throw error;
      console.warn(`[AgentHarness Router] Provider ${candidate.name || candidate.id} lỗi: ${error.message}`);
      
      // Nếu là lỗi không thể phục hồi (bad request, auth lỗi) -> Dừng luôn, không fallback lãng phí
      if (!isRecoverableProviderError(error)) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
  throw lastError || new Error('Không có AI Provider khả dụng.');
}

class AgentHarness {
  constructor({ toolManager, maxIterations = 8, timeoutMs = 45000 } = {}) {
    this.toolManager = toolManager;
    this.maxIterations = maxIterations;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Chạy Agentic Loop
   * @param {object} params
   * @param {string} params.userMessage
   * @param {Array}  params.messages
   * @param {object} params.provider
   * @param {Array<string>} [params.enabledToolNames]
   * @param {object} [params.context]
   */
  async run({ userMessage, messages = [], provider, enabledToolNames = null, context = {}, onProgress = null }) {
    const trace = {
      startTime: Date.now(),
      iterations: 0,
      steps: [],
      toolCalls: [],
      sqlRetryAttempts: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false }
    };

    const collectUsage = (usage) => {
      if (!usage) return;
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      trace.tokenUsage.inputTokens += input;
      trace.tokenUsage.outputTokens += output;
      trace.tokenUsage.totalTokens += Number(usage.totalTokens) || (input + output);
      trace.tokenUsage.calls += 1;
      trace.tokenUsage.available = true;
    };

    let activeProvider = provider || aiProviderManager.getActiveProvider();
    const providerCandidates = getProviderCandidates(activeProvider);
    const providerFallbacks = [];

    const toolContext = { ...context, allowedToolNames: enabledToolNames };
    const toolDefs = this.toolManager ? this.toolManager.getToolDefinitions(toolContext) : [];
    const conversation = [...messages];

    const triedSqlFingerprints = new Set();
    let sqlRetriesCount = 0;
    const MAX_SQL_RETRIES = 2;

    let finalText = null;
    const toolCallsLog = [];

    // Trích xuất các kết quả đặc thù để duy trì contract
    let extractedSqlQuery = null;
    let extractedExecutionResult = null;
    const extractedSqlExecutions = [];
    let extractedChartSpec = null;
    let extractedCalcResult = null;

    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;
      trace.iterations = iterations;
      emitProgress(onProgress, { type: 'model_started', label: `Đang gọi model · vòng ${iterations}`, status: 'running', icon: 'brain', iteration: iterations, providerName: activeProvider?.name });

      let assistantMsg;
      try {
        const dispatched = await dispatchWithProviderFallback(
          activeProvider,
          providerCandidates,
          conversation,
          toolDefs,
          providerFallbacks,
          collectUsage,
          context.signal
        );
        assistantMsg = dispatched.response;
        activeProvider = dispatched.provider;
        emitProgress(onProgress, { type: 'model_completed', label: `Model đã hoàn thành vòng ${iterations}`, status: 'done', icon: 'robot', iteration: iterations, providerName: activeProvider?.name });
      } catch (llmErr) {
        trace.steps.push({ iteration: iterations, type: 'error', error: llmErr.message });
        throw llmErr;
      }

      conversation.push({
        role: 'assistant',
        content: assistantMsg.content || '',
        rawParts: assistantMsg.rawParts || null,
        tool_calls: assistantMsg.tool_calls
      });

      // 1. Nếu không có tool calls -> LLM đã trả lời xong
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        finalText = assistantMsg.content || '';
        trace.steps.push({
          iteration: iterations,
          type: 'final_answer',
          content: securityGuard.maskSensitiveData(finalText)
        });
        break;
      }

      // 2. Thực thi từng Tool Call
      trace.steps.push({
        iteration: iterations,
        type: 'tool_calls',
        toolCount: assistantMsg.tool_calls.length,
        calls: assistantMsg.tool_calls.map(tc => ({ name: tc.function?.name || tc.name, id: tc.id }))
      });

      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function?.name || toolCall.name;
        let toolArgs = {};
        try {
          toolArgs = typeof toolCall.function?.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : (toolCall.function?.arguments || toolCall.input || {});
        } catch (_) {
          toolArgs = { _raw: toolCall.function?.arguments };
        }

        emitProgress(onProgress, { type: 'tool_started', label: toolLabel(toolName), status: 'running', icon: toolName === 'execute_sql_query' ? 'database' : toolName === 'render_chart' ? 'chart-column' : 'gear', iteration: iterations, toolName });
        const execution = await this.toolManager.executeTool(toolName, toolArgs, context);
        emitProgress(onProgress, {
          type: 'tool_completed', label: execution.success ? toolLabel(toolName, 'done', execution.result?.rowCount ?? execution.result?.rows?.length) : `${toolName} gặp lỗi, đang thử điều chỉnh`,
          status: execution.success ? 'done' : 'error', icon: execution.success ? 'check' : 'xmark', iteration: iterations,
          toolName, rowCount: execution.result?.rowCount ?? execution.result?.rows?.length, durationMs: execution.durationMs
        });

        toolCallsLog.push({
          toolName,
          args: toolArgs,
          success: execution.success,
          result: execution.result || null,
          error: execution.error || null,
          durationMs: execution.durationMs
        });

        trace.toolCalls.push({
          toolName,
          args: toolArgs,
          success: execution.success,
          durationMs: execution.durationMs
        });

        // Hợp nhất các trường đặc thù vào extracted contract
        if (toolName === 'execute_sql_query') {
          if (execution.success && execution.result) {
            extractedSqlQuery = execution.result.sql || toolArgs.sql;
            extractedExecutionResult = execution.result;
            extractedSqlExecutions.push({
              sql: extractedSqlQuery,
              rowCount: execution.result.rowCount || 0,
              success: true
            });
          } else {
            extractedSqlExecutions.push({
              sql: toolArgs.sql,
              error: execution.error,
              success: false
            });
          }
        } else if (toolName === 'render_chart' && execution.success && execution.result?.chartSpec) {
          extractedChartSpec = execution.result.chartSpec;
        } else if ((toolName === 'calculate_stats' || toolName === 'calculate_expression') && execution.success) {
          extractedCalcResult = execution.result;
        }

        let toolResponseContent = '';

        // Cơ chế Self-Healing SQL có budget và deduplication
        if (!execution.success && toolName === 'execute_sql_query' && sqlRetriesCount < MAX_SQL_RETRIES) {
          sqlRetriesCount++;
          trace.sqlRetryAttempts = sqlRetriesCount;
          const fp = errorRecovery.getFingerprint(toolArgs.sql);
          triedSqlFingerprints.add(fp);

          const recovery = errorRecovery.analyzeSqlError(toolArgs.sql, execution.error, triedSqlFingerprints);
          toolResponseContent = JSON.stringify({
            status: 'error',
            error: execution.error,
            recovery_guidance: recovery.guidance,
            suggested_sql: recovery.suggestedSql || undefined
          });
        } else {
          // Trả kết quả chuẩn (unwrapped result hoặc lỗi)
          toolResponseContent = JSON.stringify(
            execution.success 
              ? { success: true, result: execution.result }
              : { success: false, error: execution.error }
          );
        }

        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id || `tool-${Date.now()}`,
          name: toolName,
          content: toolResponseContent
        });
      }
    }

    // 3. Nếu hết số vòng lặp mà vẫn chưa có câu trả lời cuối cùng, gọi 1 lần synthesis không kèm tools
    if (finalText === null && toolCallsLog.length > 0) {
      try {
        emitProgress(onProgress, { type: 'synthesis_started', label: 'Đang tổng hợp câu trả lời', status: 'running', icon: 'pen', providerName: activeProvider?.name });
        const dispatched = await dispatchWithProviderFallback(
          activeProvider,
          providerCandidates,
          conversation,
          [],
          providerFallbacks,
          collectUsage,
          context.signal
        );
        activeProvider = dispatched.provider;
        finalText = dispatched.response.content || '';
      } catch (e) {
        if (context.signal?.aborted || e?.name === 'AbortError') throw e;
        console.error('[AgentHarness] Lỗi khi gọi LLM lần cuối để tổng hợp kết quả:', e.message);
      }
    }

    trace.durationMs = Date.now() - trace.startTime;
    emitProgress(onProgress, { type: 'request_completed', label: 'Đã hoàn thành câu trả lời', status: 'done', icon: 'check', durationMs: trace.durationMs });

    return {
      replyText: securityGuard.maskSensitiveData(finalText || ''),
      toolCalls: toolCallsLog,
      usedProvider: activeProvider,
      providerFallbacks,
      tokenUsage: trace.tokenUsage,
      sqlQuery: extractedSqlQuery,
      executionResult: extractedExecutionResult,
      sqlExecutions: extractedSqlExecutions,
      chartSpec: extractedChartSpec,
      calcResult: extractedCalcResult,
      trace,
      conversation
    };
  }
}

module.exports = AgentHarness;
