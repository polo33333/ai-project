/**
 * Intelligent Core — Agentic Loop
 * Flow: User → [Build Prompt] → LLM → [Tool Call?] → Execute → LLM → Answer
 * Provider routing via ./adapters/index.js
 */

const aiPersonaService  = require('./ai_persona_service');
const aiProviderManager = require('../services/ai_provider_manager');
const toolRegistry      = require('./tool_registry');
const securityGuard     = require('./security_guard');
const schemaContextService = require('./schema_context_service');
const retrievalService = require('../knowledge_core/services/retrieval_service');
const libraryService = require('../knowledge_core/services/library_service');
const sqlConnector = require('../services/sql_connector');
const { needsKnowledgeSearch } = require('./knowledge_intent');
const { dispatchToProvider } = require('./adapters');
const { isLocalProvider } = require('../agent_core/harness/provider_classifier');
const { emitProgress } = require('../agent_core/harness/progress_events');
const { trainingService } = require('../training_core');
const webSearchService = require('../services/web_search_service');
const { memoryService, policy: memoryPolicy } = require('../memory_core');
const { RequestExecutionBudget } = require('../agent_core/harness/request_execution_budget');
const { buildSelectedKnowledgeMessages } = require('./knowledge_prompt_policy');

const MAX_TOOL_ITERATIONS = parseInt(process.env.AI_MAX_TOOL_ITERATIONS || '10',    10);
const REQUEST_TIMEOUT_MS  = parseInt(process.env.AI_DEFAULT_TIMEOUT_MS || '30000', 10);
const LOCAL_REQUEST_TIMEOUT_MS = parseInt(process.env.AI_LOCAL_TIMEOUT_MS || process.env.AI_DEFAULT_TIMEOUT_MS, 10);

function providerTimeoutMs(provider) {
  return isLocalProvider(provider) ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

function getProviderCandidates(selectedProvider) {
  let fallbacks = aiProviderManager.getProvidersForExecution()
    .filter(candidate => candidate.id !== selectedProvider?.id)
    .filter(candidate => candidate.baseUrl && candidate.model && candidate.status !== 'unconfigured')
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999));
  if (isLocalProvider(selectedProvider) && process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK !== 'true') {
    fallbacks = fallbacks.filter(isLocalProvider);
  }
  return [selectedProvider, ...fallbacks].filter(Boolean);
}

async function dispatchWithProviderFallback(currentProvider, candidates, messages, tools, fallbackLog, externalSignal = null, executionBudget = null) {
  const ordered = [currentProvider, ...candidates.filter(candidate => candidate.id !== currentProvider?.id)];
  let lastError = null;
  for (const candidate of ordered) {
    executionBudget?.consumeModelCall();
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const configuredTimeoutMs = providerTimeoutMs(candidate);
    const timeoutMs = executionBudget
      ? Math.min(configuredTimeoutMs, executionBudget.remainingMs())
      : configuredTimeoutMs;
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const response = await dispatchToProvider(candidate, messages, tools, controller.signal);
      const internalRetries = Math.max(0, (Number(response?.usage?.calls) || 1) - 1);
      for (let index = 0; index < internalRetries; index += 1) executionBudget?.consumeModelCall();
      if (candidate.id !== currentProvider?.id) {
        fallbackLog.push({
          fromProviderId: currentProvider?.id || null,
          toProviderId: candidate.id,
          toProviderName: candidate.name,
          reason: lastError?.message || 'Provider unavailable'
        });
      }
      return { response, provider: candidate };
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || error?.name === 'AbortError') throw error;
      console.warn(`[AI Router] Provider ${candidate.name || candidate.id} lỗi, thử provider priority tiếp theo: ${error.message}`);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }
  throw lastError || new Error('Không có AI Provider khả dụng.');
}

function parseSelectedTableNames(content) {
  const clean = String(content || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    const values = Array.isArray(parsed) ? parsed : (parsed.tables || parsed.tableNames || []);
    return values.map(value => typeof value === 'string' ? value : value?.tableName).filter(Boolean);
  } catch (_) {
    return clean.split(/[\n,]+/).map(value => value.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  }
}

function isSimpleArithmeticQuery(value) {
  const query = String(value || '').trim();
  return /\d/.test(query) && /^[\d\s()+\-*/%.]+$/.test(query);
}

class IntelligentCore {
  /**
   * Xử lý một tin nhắn từ người dùng — agentic loop
   * @param {string} userMessage      - Câu hỏi/yêu cầu từ user
   * @param {object} options
   * @param {string}  [options.providerId] - Override provider
   * @param {Array}   [options.history]    - Lịch sử chat (last N turns)
   * @param {boolean} [options.useTools]   - Kích hoạt tool calling (default: true)
   */
  async chat(userMessage, options = {}) {
    const { providerId, history = [], useTools = true, knowledgeSearchEnabled = true, knowledgeSourceIds = [], webSearch = false } = options;

    if (options.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const inputCheck = securityGuard.validateInput(userMessage);
    if (!inputCheck.safe) return this._buildErrorResponse(userMessage, aiProviderManager.getActiveProvider(), inputCheck.reason);

    // ── Resolve provider ───────────────────────────────────────────────────
    let provider = aiProviderManager.getActiveProvider();
    if (providerId) {
      const found = aiProviderManager.getProviderForExecution(providerId);
      if (found) provider = found;
    }
    const providerCandidates = getProviderCandidates(provider);
    const executionBudget = isLocalProvider(provider) ? new RequestExecutionBudget({
      maxModelCalls: Number(process.env.LOCAL_MODEL_MAX_MODEL_CALLS || 9),
      maxSqlAttempts: Number(process.env.LOCAL_MODEL_MAX_SQL_CALLS || 3)
    }) : null;
    emitProgress(options.onProgress, { type: 'request_started', label: 'Đang phân tích yêu cầu', status: 'running', icon: 'brain', providerName: provider?.name });
    const providerFallbacks = [];
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false };
    const collectUsage = usage => {
      if (!usage) return;
      const input = Number(usage.inputTokens) || 0;
      const output = Number(usage.outputTokens) || 0;
      tokenUsage.inputTokens += input;
      tokenUsage.outputTokens += output;
      tokenUsage.totalTokens += Number(usage.totalTokens) || (input + output);
      tokenUsage.calls += Math.max(1, Number(usage.calls) || 0);
      tokenUsage.available = true;
    };

    const scope = securityGuard.checkScope(userMessage);
    if (!scope.allowed) {
      return this._buildSuccessResponse(
        userMessage, scope.reply, [], provider, null, [],
        { mode: 'restricted', selectedTables: [], retrieval: { reason: 'out_of_scope' } }
      );
    }

    // ── Retrieve only relevant schema; general chat gets no database context ──
    const selectedDb = options.dbSourceId
      ? sqlConnector.getDbSources().find(source => source.id === options.dbSourceId)
      : sqlConnector.getDefaultDbSource();
    emitProgress(options.onProgress, { type: 'context_started', label: 'Đang chọn ngữ cảnh và cấu trúc dữ liệu', status: 'running', icon: 'book-open' });
    let contextSelection = await schemaContextService.buildSchemaContext(userMessage, { dbName: selectedDb?.dbName || null, dbSourceId: selectedDb?.id || null });
    if (webSearch) {
      contextSelection.mode = 'general';
      contextSelection.selectedTables = [];
      contextSelection.schemaContext = '';
      contextSelection.useTools = false;
    }
    contextSelection.dbSourceId = selectedDb?.id || null;
    contextSelection.dbName = selectedDb?.dbName || null;
    emitProgress(options.onProgress, {
      type: 'context_completed',
      label: contextSelection.mode === 'data' ? `Đã chọn ${contextSelection.selectedTables?.length || 0} bảng dữ liệu phù hợp` : 'Đã chuẩn bị ngữ cảnh hội thoại',
      status: 'done', icon: contextSelection.mode === 'data' ? 'diagram-project' : 'message'
    });
    const allowModelSchemaSelection = !isLocalProvider(provider) || process.env.LOCAL_MODEL_SCHEMA_SELECTOR_ENABLED === 'true';
    if (contextSelection.mode === 'data' && contextSelection.needsModelSelection && contextSelection.tableCatalog && allowModelSchemaSelection) {
      try {
        const selectorMessages = [
          { role: 'system', content: 'Select the database tables relevant to the user request. Return only JSON: {"tables":["TableName"]}. Choose at most 6 exact names from the catalog. Do not invent names.' },
          { role: 'user', content: `Request: ${userMessage}\n\nTable catalog:\n${contextSelection.tableCatalog}` }
        ];
        const dispatched = await dispatchWithProviderFallback(provider, providerCandidates, selectorMessages, [], providerFallbacks, options.signal, executionBudget);
        provider = dispatched.provider;
        collectUsage(dispatched.response.usage);
        const refined = schemaContextService.refineSchemaContext(userMessage, parseSelectedTableNames(dispatched.response.content), { dbName: selectedDb?.dbName || null, dbSourceId: selectedDb?.id || null });
        if (refined) contextSelection = refined;
      } catch (error) {
        if (options.signal?.aborted || error?.name === 'AbortError') throw error;
        console.warn(`[Schema Retriever] Model table selector unavailable, using hybrid result: ${error.message}`);
      }
    }
    if (contextSelection.mode === 'data' && contextSelection.needsModelSelection && !allowModelSchemaSelection) {
      contextSelection.retrieval = { ...(contextSelection.retrieval || {}), strategy: 'hybrid_local_safe' };
    }
    contextSelection.dbSourceId = selectedDb?.id || null;
    contextSelection.dbName = selectedDb?.dbName || null;
    let documentContext = '';
    let webContext = '';
    let webTemporalGrounding = null;
    if (webSearch) {
      emitProgress(options.onProgress, { type: 'web_search_started', label: 'Đang tìm kiếm trên web', status: 'running', icon: 'globe' });
      try {
        const contextualizeWebSearch = memoryPolicy.isShortContextualFollowup(userMessage);
        webTemporalGrounding = webSearchService.getTemporalGrounding(userMessage);
        const contextualQuery = webSearchService.buildContextualQuery(userMessage, history, contextualizeWebSearch);
        const webSearchQuery = webSearchService.groundTemporalQuery(contextualQuery, webTemporalGrounding);
        const rawWebResults = await webSearchService.search(webSearchQuery, { signal: options.signal });
        const webResults = webSearchService.rankResultsForTemporalGrounding(rawWebResults, webTemporalGrounding);
        if (!webResults.length) throw new Error('Không tìm thấy kết quả web phù hợp.');
        webContext = webResults.map((item, index) => `[Web ${index + 1}] ${item.title}\nURL: ${item.url}\n${item.snippet}`).join('\n\n');
        contextSelection.webSearch = {
          enabled: true, contextualized: contextualQuery !== userMessage,
          query: webSearchQuery, temporalGrounding: webTemporalGrounding?.required ? webTemporalGrounding : null,
          resultCount: webResults.length, sources: webResults.map(item => ({ title: item.title, url: item.url }))
        };
        emitProgress(options.onProgress, { type: 'web_search_completed', label: `Đã tìm thấy ${webResults.length} kết quả web`, status: 'done', icon: 'globe' });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        contextSelection.webSearch = { enabled: true, resultCount: 0, error: error.message };
        emitProgress(options.onProgress, { type: 'web_search_completed', label: 'Không thể lấy kết quả web', status: 'error', icon: 'globe' });
      }
    }
    if (!knowledgeSearchEnabled || webSearch) contextSelection.knowledgeMode = 'disabled';
    const knowledgeIntent = needsKnowledgeSearch(userMessage, {
      sourceIds: knowledgeSourceIds,
      documents: libraryService.getDocuments()
    });
    const skipUtilitySearch = /^\s*(hi|hello|hey|chào|xin chào|cảm ơn)\s*[.!?]*$/i.test(userMessage)
      || isSimpleArithmeticQuery(userMessage);
    const shouldSearchKnowledge = !webSearch && knowledgeSearchEnabled && knowledgeIntent.needed;
    if (shouldSearchKnowledge) {
      emitProgress(options.onProgress, { type: 'knowledge_started', label: 'Đang tìm trong kho tri thức', status: 'running', icon: 'magnifying-glass' });
      contextSelection.knowledgeRouting = { searched: true, reason: knowledgeIntent.reason };
      const retrieval = await retrievalService.search(userMessage, { limit: 6, documentIds: knowledgeSourceIds });
      const relevant = retrieval.results;
      if (relevant.length) {
        documentContext = relevant.map((hit, index) => {
          const payload = hit.payload || {};
          return `[Tài liệu ${index + 1}: ${payload.title || 'Không tên'} · đoạn ${Number(payload.chunkIndex || 0) + 1}]\n${payload.fullText || ''}`;
        }).join('\n\n').slice(0, Number(process.env.AI_DOCUMENT_CONTEXT_CHARS || 12000));
        contextSelection.documentSources = [...new Set(relevant.map(hit => hit.payload?.title).filter(Boolean))];
        contextSelection.knowledgeMode = knowledgeSourceIds.length ? 'selected_hybrid' : retrieval.mode;
        contextSelection.graphActivated = retrieval.graphActivated;
        contextSelection.retrievalPipeline = {
          chunksSelected: relevant.length,
          reranked: relevant.some(hit => hit.reranked === true),
          retrievalSources: [...new Set(relevant.flatMap(hit => hit.retrievalSources || []))]
        };
      }
      emitProgress(options.onProgress, { type: 'knowledge_completed', label: `Đã tìm thấy ${relevant.length} đoạn tri thức liên quan`, status: 'done', icon: 'book' });
    } else if (knowledgeSearchEnabled) {
      contextSelection.knowledgeMode = skipUtilitySearch ? 'skipped_utility' : 'skipped_no_intent';
      contextSelection.knowledgeRouting = {
        searched: false,
        reason: skipUtilitySearch ? 'utility_query' : knowledgeIntent.reason
      };
    }
    const strictSelectedKnowledge = knowledgeSourceIds.length > 0 && Boolean(documentContext);
    if (strictSelectedKnowledge) {
      contextSelection.mode = 'knowledge';
      contextSelection.selectedTables = [];
      contextSelection.schemaContext = '';
    }
    const schemaContext = strictSelectedKnowledge ? '' : (contextSelection.schemaContext || '');
    const knowledgePrompt = documentContext ? `

# Nguồn tài liệu doanh nghiệp${strictSelectedKnowledge ? ' được người dùng chọn — BẮT BUỘC ƯU TIÊN' : ''}
${documentContext}

${strictSelectedKnowledge
  ? 'Trả lời trực tiếp từ nguồn tài liệu trên. Không trả lời kiến thức chung, không nói thiếu thông tin nếu nội dung đã có trong nguồn, và phải nêu tên tài liệu nguồn.'
  : 'Chỉ dùng nội dung trên khi liên quan và nêu tên tài liệu nguồn trong câu trả lời.'}` : '';

    // ── Prepare tools and system prompt ───────────────────────────────────
    // General conversation does not need database tools, but utility tools must
    // remain available (for example, current date/time questions).
    const generalToolNames = ['get_current_datetime', 'calculate_expression', 'calculate_stats'];
    const enabledToolNames = contextSelection.mode === 'knowledge' ? [] : (contextSelection.mode === 'general' ? generalToolNames : null);
    const effectiveUseTools = contextSelection.mode !== 'knowledge' && useTools && (contextSelection.useTools || enabledToolNames?.length > 0);
    const requestPlan = trainingService.plan({ question: userMessage, selectedTables: contextSelection.selectedTables || [] });
    const memoryDecision = memoryService.route({
      sessionId: options.session?.id,
      accountId: options.session?.accountId || null,
      question: userMessage,
      currentPlan: requestPlan,
      fallbackHistory: history
    });
    // A selected document is an explicit scope for the current question.
    // Replaying only old user turns makes them look unanswered and causes the
    // model to answer earlier questions again.
    const memoryHistory = strictSelectedKnowledge ? [] : memoryService.getContext(memoryDecision);
    const memorySystemContext = memoryHistory.filter(item => item?.role === 'system').map(item => item.content).filter(Boolean).join('\n');
    const temporalWebInstruction = webTemporalGrounding?.required
      ? `\nMốc thời gian bắt buộc: hiện tại là ngày ${String(webTemporalGrounding.day).padStart(2, '0')}/${String(webTemporalGrounding.month).padStart(2, '0')}/${webTemporalGrounding.year}, múi giờ ${webTemporalGrounding.timezone}. Các từ “hôm nay”, “tháng này”, “năm nay” phải bám mốc này. Không gọi năm khác là năm nay; bỏ qua nguồn xung đột năm khi đã có nguồn đúng ${webTemporalGrounding.year}.`
      : '';
    const webPrompt = webContext
      ? `\n\n# Chế độ tìm kiếm web — ƯU TIÊN CAO\nNgười dùng đã chủ động bật tìm kiếm web. Với yêu cầu này, thông tin từ các kết quả web dưới đây nằm trong phạm vi được phép và ghi đè giới hạn chỉ dùng dữ liệu doanh nghiệp. Không được từ chối chỉ vì thông tin không có trong CSDL nội bộ.${temporalWebInstruction}\n\n${webContext}\n\nTrả lời trực tiếp từ các kết quả trên, đính kèm URL nguồn liên quan. Chỉ khẳng định dữ kiện xuất hiện trong kết quả và không tự tạo số liệu thời gian thực.`
      : (webSearch ? '\n\n# Tìm kiếm web\nKhông lấy được kết quả web cho yêu cầu này. Hãy nói rõ rằng dữ liệu web hiện không khả dụng; không được giả vờ đã tìm thấy nguồn hoặc tự tạo URL.' : '');
    const systemPrompt = `${aiPersonaService.buildSystemPrompt(
      schemaContext,
      effectiveUseTools ? toolRegistry.listTools(enabledToolNames) : []
    )}${knowledgePrompt}${webPrompt}${memorySystemContext && !strictSelectedKnowledge ? `\n\n# Memory hội thoại\n${memorySystemContext}` : ''}`;

    // ── Build messages array (OpenAI-compat) ──────────────────────────────
    const messages = strictSelectedKnowledge
      ? buildSelectedKnowledgeMessages(systemPrompt, userMessage)
      : [
          { role: 'system', content: systemPrompt },
          ...memoryHistory.filter(item => item?.role !== 'system'),
          { role: 'user', content: userMessage }
        ];

    // ── Giai đoạn chuyển tiếp: Feature Flag AGENT_CORE_ENABLED (Mặc định: true) ──
    const isAgentCoreEnabled = process.env.AGENT_CORE_ENABLED !== 'false';

    if (isAgentCoreEnabled) {
      try {
        const { defaultHarness, localHarness } = require('../agent_core');
        const useLocalHarness = process.env.LOCAL_MODEL_HARNESS_ENABLED !== 'false' && isLocalProvider(provider);
        const selectedHarness = useLocalHarness ? localHarness : defaultHarness;
        const harnessResult = await selectedHarness.run({
          userMessage,
          messages,
          provider,
          enabledToolNames: effectiveUseTools ? enabledToolNames : [],
          context: {
            permissions: options.permissions || [], session: options.session, dbSourceId: selectedDb?.id || null,
            selectedTables: contextSelection.selectedTables || [],
            requestPlan,
            memoryDecision,
            webSearch: Boolean(webSearch),
            webSearchResultCount: contextSelection.webSearch?.resultCount || 0,
            webTemporalGrounding,
            signal: options.signal || null,
            executionBudget,
            knowledgeGrounding: strictSelectedKnowledge ? {
              required: true,
              sourceTitles: contextSelection.documentSources || [],
              documentContext
            } : null
          },
          onProgress: options.onProgress
        });

        // Gom token usage từ context selection + harness
        if (harnessResult.tokenUsage?.available) {
          tokenUsage.inputTokens += harnessResult.tokenUsage.inputTokens;
          tokenUsage.outputTokens += harnessResult.tokenUsage.outputTokens;
          tokenUsage.totalTokens += harnessResult.tokenUsage.totalTokens;
          tokenUsage.calls += harnessResult.tokenUsage.calls;
          tokenUsage.available = true;
        }

        const allFallbacks = [...providerFallbacks, ...(harnessResult.providerFallbacks || [])];

        const responseEvaluation = harnessResult.trace?.training?.responseEvaluation
          || trainingService.evaluateResponse({ reply: harnessResult.replyText, plan: requestPlan, toolCalls: harnessResult.toolCalls });
        const trace = {
          ...(harnessResult.trace || {}),
          training: { ...(harnessResult.trace?.training || {}), plan: requestPlan, responseEvaluation },
          completionStatus: harnessResult.trace?.completionStatus || (responseEvaluation.valid ? 'SUCCESS' : 'PARTIAL')
        };
        if (memoryPolicy.traceEnabled()) trace.memoryDecision = { ...memoryDecision, fallbackHistory: undefined, accountId: undefined };

        return this._buildSuccessResponse(
          userMessage,
          harnessResult.replyText,
          harnessResult.toolCalls,
          harnessResult.usedProvider || provider,
          tokenUsage,
          allFallbacks,
          contextSelection,
          trace
        );
      } catch (agentErr) {
        if (options.signal?.aborted) throw agentErr;
        console.error(`[IntelligentCore] AgentHarness lỗi: ${agentErr.message}. Kiểm tra fallback nếu cần.`);
        return this._buildErrorResponse(userMessage, provider, agentErr.message);
      }
    }

    // ── Legacy Fallback Loop (Khi AGENT_CORE_ENABLED=false) ────────────────
    const tools = effectiveUseTools ? toolRegistry.getOpenAiToolsFormat(enabledToolNames) : [];
    const toolCallsLog = [];
    let iterations = 0;
    let finalText = null;

    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      let assistantMsg;
      try {
        const dispatched = await dispatchWithProviderFallback(provider, providerCandidates, messages, tools, providerFallbacks, options.signal, executionBudget);
        assistantMsg = dispatched.response;
        provider = dispatched.provider;
      } catch (llmErr) {
        if (options.signal?.aborted) throw llmErr;
        return this._buildErrorResponse(userMessage, provider, llmErr.message);
      }
      collectUsage(assistantMsg.usage);

      messages.push({
        role: 'assistant',
        content: assistantMsg.content || '',
        rawParts: assistantMsg.rawParts || null,
        tool_calls: assistantMsg.tool_calls
      });

      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        finalText = assistantMsg.content || '';
        break;
      }

      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function?.name || toolCall.name;
        let toolArgs = {};
        try {
          toolArgs = typeof toolCall.function?.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : (toolCall.function?.arguments || toolCall.input || {});
        } catch (_) {}

        const toolResult = await toolRegistry.executeTool(toolName, toolArgs);

        toolCallsLog.push({
          toolName, args: toolArgs,
          success: toolResult.success,
          result: toolResult.result || null,
          error:  toolResult.error  || null
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id || `tool-${Date.now()}`,
          name: toolName,
          content: JSON.stringify(toolResult)
        });
      }
    }

    if (finalText === null && toolCallsLog.length > 0) {
      try {
        const dispatched = await dispatchWithProviderFallback(provider, providerCandidates, messages, [], providerFallbacks, options.signal, executionBudget);
        provider = dispatched.provider;
        collectUsage(dispatched.response.usage);
        finalText = dispatched.response.content || '';
      } catch (e) {
        console.error("Lỗi khi gọi LLM lần cuối để tổng hợp kết quả:", e.message);
      }
    }

    return this._buildSuccessResponse(userMessage, finalText, toolCallsLog, provider, tokenUsage, providerFallbacks, contextSelection);
  }

  // ─── Response Builders ───────────────────────────────────────────────────

  _buildSuccessResponse(question, replyText, toolCallsLog, provider, tokenUsage = null, providerFallbacks = [], contextSelection = null, trace = null) {
    const hasSql   = toolCallsLog.some(t => t.toolName === 'execute_sql_query' && t.success);
    const hasChart = toolCallsLog.some(t => t.toolName === 'render_chart'       && t.success);
    const hasCalc  = toolCallsLog.some(t =>
      ['calculate_stats', 'calculate_expression'].includes(t.toolName) && t.success
    );

    const sqlEntries = hasSql ? toolCallsLog.filter(t => t.toolName === 'execute_sql_query' && t.success) : [];
    const sqlEntry   = sqlEntries.length > 0 ? sqlEntries[sqlEntries.length - 1] : null;
    const chartEntry = hasChart ? toolCallsLog.find(t => t.toolName === 'render_chart'       && t.success) : null;
    const calcEntry  = hasCalc  ? toolCallsLog.find(t =>
      ['calculate_stats', 'calculate_expression'].includes(t.toolName) && t.success
    ) : null;

    let cleanReplyText = String(replyText || '')
      .replace(/\{\s*(?:render[_-]?)?chart\s*\}/gi, '')
      .replace(/\{\s*(?:sql|table)\s*\}/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Nếu đã có kết quả SQL trả về dạng bảng riêng, tự động loại bỏ khối ```sql...``` lặp lại gây xấu giao diện
    if (hasSql) {
      cleanReplyText = cleanReplyText.replace(/```(?:sql|tsql)?[\s\S]*?```/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    return {
      success: true,
      question,
      replyText: securityGuard.maskSensitiveData(cleanReplyText),
      type: hasSql ? 'sql_query' : hasChart ? 'chart' : hasCalc ? 'calculation' : 'general_chat',
      executionMode: 'live_llm',
      toolCalls: toolCallsLog,
      sqlQuery:        sqlEntry   ? (sqlEntry.result?.sql || sqlEntry.args?.sql) : null,
      executionResult: sqlEntry   ? securityGuard.sanitizeTabularRows(sqlEntry.result?.rows) : null,
      sqlExecutions: sqlEntries.map((entry, index) => ({
        index: index + 1,
        sql: entry.result?.sql || entry.args?.sql || null,
        rows: securityGuard.sanitizeTabularRows(entry.result?.rows),
        columns: (entry.result?.columns || []).filter(column => !securityGuard.isSensitiveFieldName(column)),
        rowCount: entry.result?.rowCount ?? entry.result?.rows?.length ?? 0
      })),
      chartSpec:       chartEntry ? chartEntry.result?.chartSpec  : null,
      calcResult:      calcEntry  ? calcEntry.result              : null,
      tokenUsage: tokenUsage?.available ? tokenUsage : null,
      providerFallbacks,
      trace,
      contextSelection: contextSelection ? {
        mode: contextSelection.mode,
        selectedTables: contextSelection.selectedTables,
        selectedTableIds: contextSelection.selectedTableIds || [],
        retrieval: contextSelection.retrieval || null,
        documentSources: contextSelection.documentSources || [],
        knowledgeMode: contextSelection.knowledgeMode || 'auto',
        knowledgeRouting: contextSelection.knowledgeRouting || null,
        graphActivated: contextSelection.graphActivated === true,
        retrievalPipeline: contextSelection.retrievalPipeline || null,
        webSearch: contextSelection.webSearch || null,
        dbSourceId: contextSelection.dbSourceId || null,
        dbName: contextSelection.dbName || null
      } : null,
      usedProvider: {
        id:    provider.id,
        name:  provider.name,
        model: provider.model,
        type:  provider.type
      }
    };
  }

  _buildErrorResponse(question, provider, errMsg) {
    return {
      success: false,
      question,
      replyText: null,
      type: 'error',
      executionMode: 'error',
      error: errMsg,
      toolCalls: [],
      sqlQuery: null, executionResult: null, chartSpec: null, calcResult: null,
      usedProvider: {
        id:    provider?.id,
        name:  provider?.name,
        model: provider?.model,
        type:  provider?.type
      }
    };
  }
}

module.exports = new IntelligentCore();
