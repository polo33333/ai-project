/**
 * Intelligent Core — Agentic Loop
 * Flow: User → [Build Prompt] → LLM → [Tool Call?] → Execute → LLM → Answer
 * Provider routing via ./adapters/index.js
 */

const aiPersonaService  = require('./ai_persona_service');
const aiProviderManager = require('../services/ai_provider_manager');
const toolRegistry      = require('./tool_registry');
const securityGuard     = require('./security_guard');
const retrievalService = require('../knowledge_core/services/retrieval_service');
const citationService = require('../knowledge_core/services/citation_service');
const documentConversation = require('../memory_core/document_conversation');
const libraryService = require('../knowledge_core/services/library_service');
const sqlConnector = require('../services/sql_connector');
const { dispatchToProvider } = require('./adapters');
const { isLocalProvider } = require('../agent_core/harness/provider_classifier');
const { emitProgress } = require('../agent_core/harness/progress_events');
const { trainingService } = require('../training_core');
const webSearchService = require('../services/web_search_service');
const { memoryService, policy: memoryPolicy } = require('../memory_core');
const { estimateTokens, fitOptionalMessages, measureMessages } = require('../agent_core/harness/context_budget');
const { buildSelectedKnowledgeMessages } = require('./knowledge_prompt_policy');
const { resolvePlan } = require('../agent_core/harness/completion_policy');
const { buildCalculationReply } = require('../agent_core/harness/calculation_reply');
const { withModelTokenUsage } = require('../utils/model_token_usage');

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
    const answerStream=require('../services/chat_answer_stream').createAnswerStream(options.onAnswer,{signal:options.signal});
    options={...options,answerStream};
    try {
    const result = await (options.webSearch
      ? require('../governance/context').isolateResources(() => this._chat(userMessage, { providerId: options.providerId, webSearch: true, signal: options.signal, onProgress: options.onProgress }))
      : this._chat(userMessage, options));
    const workflow = [...(result.toolCalls || [])].reverse().find(call => call.success && ['run_workflow', 'get_workflow_status', 'resume_workflow', 'cancel_workflow'].includes(call.toolName));
    if (workflow?.result?.execution && !result.execution) result.execution = workflow.result.execution;
    if (workflow?.result?.execution?.status === 'SUCCEEDED') result.execution = await require('../governance/workflow_tools').delivery(workflow.result.runId, options);
    result.trace ||= {};
    result.trace.controller = { version: '1', mode: 'governed_agent', legacyRoutingSkipped: true,
      workflowAction: workflow?.toolName || null, executionRef: result.execution?.id || null };
    require('../agent_core/harness/answer_envelope').createAnswerEnvelope(result);
    answerStream.commit(result);
    if(answerStream.metrics.enabled){result.trace||={};result.trace.streaming={...answerStream.metrics};}
    return result;
    }catch(error){answerStream.reset();throw error;}
  }

  async _chat(userMessage, options = {}) {
    const memoryService = options.memoryService || require('../memory_core').memoryService;
    const { providerId, history = [], useTools = true, knowledgeSearchEnabled = true, knowledgeSourceIds = [], webSearch = false } = options;

    if (options.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const inputCheck = securityGuard.validateInput(userMessage);
    if (!inputCheck.safe) return this._buildErrorResponse(userMessage, aiProviderManager.getActiveProvider(), inputCheck.reason);
    if (webSearch) {
      const result = await require('./web_chat').run(userMessage, options);
      return this._buildSuccessResponse(userMessage, result.replyText, [], result.provider, result.tokenUsage, [], result.contextSelection, result.trace);
    }

    const selectedKnowledgeRequest = knowledgeSearchEnabled && !webSearch && knowledgeSourceIds.length > 0;
    let documentScopedRequest = selectedKnowledgeRequest;
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false };
    const explicitlySelectedProvider = providerId ? aiProviderManager.getProviderForExecution(providerId) : null;
    if (providerId && !explicitlySelectedProvider) {
      return this._buildErrorResponse(userMessage, null, 'Model đã chọn không khả dụng. Hãy chọn lại model.');
    }
    // Account lock/quota is decided once, before any work, so the user sees the reason instead of a
    // half-finished answer; a question that starts within the quota is allowed to finish.
    try {
      const usage = require('../services/ai_usage_service');
      await usage.service.check({ accountId: usage.currentAccountId(), admitted: require('../governance/context').current()?.aiUsageAdmitted });
    } catch (error) { return { ...this._buildErrorResponse(userMessage, explicitlySelectedProvider, error.message), errorCode: error.code }; }
    let routingContext;
    try { routingContext = require('../governance/controller').createContext({ ...options, chatProviderSnapshot: explicitlySelectedProvider || undefined }); }
    catch (error) { return { ...this._buildErrorResponse(userMessage, explicitlySelectedProvider, error.message), errorCode: error.code }; }
    const provider = routingContext.chatProviderSnapshot;
    const executionBudget = routingContext.executionBudget;
    if (require('../governance/context').current()) require('../governance/context').current().executionBudget = executionBudget;
    const documentFollowup = knowledgeSearchEnabled && !webSearch && documentConversation.isDocumentFollowup(userMessage);
    if (!selectedKnowledgeRequest && documentFollowup) {
      // Resolve explicit document references before the agent can send the
      // follow-up to chat/database and discard its document state.
      documentScopedRequest = true;
      routingContext.trace.flow = 'knowledge';
      routingContext.trace.decisionSource = 'document_followup';
      routingContext.trace.stages.push({ decisionSource: 'document_followup', status: 'resolved', calls: 0,
        httpRequests: 0, decisionEvaluations: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    const priorWorkflow = memoryService.getSession(options.session?.id, false, options.session?.accountId || null)?.lastWorkflowRun;
    let workflowMemoryAllowed = true;
    if (priorWorkflow) {
      try { await require('../automation/conversation_memory').readRun(priorWorkflow.runId, options); }
      catch (_) { workflowMemoryAllowed = false; }
    }
    if (documentScopedRequest) {
      if (selectedKnowledgeRequest) {
        routingContext.trace.decisionSource = 'selected_knowledge';
        routingContext.trace.stages.push({ decisionSource: 'selected_knowledge', status: 'skipped', calls: 0, httpRequests: 0, decisionEvaluations: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      }
      routingContext.trace.route = 'chat';
    }
    // All response paths carry the same routing trace, including chat errors.
    let documentTurn = null;
    const finish = response => {
      if (response.success && documentTurn && response.citations?.length && response.completionStatus === 'SUCCESS') {
        memoryService.setDocumentState(options.session?.id, options.session?.accountId || null,
          documentConversation.createState({ ...documentTurn, reply: response.replyText,
            accountId: options.session?.accountId || null }));
      } else if (response.success && !documentScopedRequest) {
        memoryService.setDocumentState(options.session?.id, options.session?.accountId || null, null);
      }
      return { ...response,
        tokenUsage: withModelTokenUsage(response.tokenUsage || (tokenUsage.available ? tokenUsage : null), routingContext.trace, provider.model),
        trace: { ...(response.trace || {}), workflowRouting: routingContext.trace, executionBudget: executionBudget.snapshot() },
        ...(response.success === false && tokenUsage.available ? { tokenUsage: withModelTokenUsage(tokenUsage, routingContext.trace, provider.model) } : {})
      };
    };
    emitProgress(options.onProgress, { type: 'request_started', label: 'Đang phân tích yêu cầu', status: 'running', icon: 'brain', providerName: provider?.name });
    const providerFallbacks = [];

    const scope = securityGuard.checkScope(userMessage);
    if (!scope.allowed) {
      return finish(this._buildSuccessResponse(
        userMessage, scope.reply, [], provider, tokenUsage, [],
        { mode: 'restricted', selectedTables: [], retrieval: { reason: 'out_of_scope' } }
      ));
    }

    // ── Retrieve only relevant schema; general chat gets no database context ──
    const selectedDb = options.dbSourceId
      ? sqlConnector.getDbSources().find(source => source.id === options.dbSourceId)
      : sqlConnector.getDefaultDbSource();
    emitProgress(options.onProgress, { type: 'context_started', label: 'Đang chọn ngữ cảnh và cấu trúc dữ liệu', status: 'running', icon: 'book-open' });
    // The agent discovers schema through tools; only knowledge and web requests are scoped here.
    const contextSelection = documentScopedRequest
      ? { mode: 'knowledge', selectedTables: [], schemaContext: '', useTools: false }
      : webSearch
      ? { mode: 'general', selectedTables: [], schemaContext: '', useTools: false }
      : { mode: 'general', selectedTables: [], schemaContext: '', useTools: true, retrieval: { strategy: 'agent_tools', semanticSearch: { status: 'skipped', reason: 'agent_decides' } } };
    contextSelection.dbSourceId = selectedDb?.id || null;
    contextSelection.dbName = selectedDb?.dbName || null;
    emitProgress(options.onProgress, { type: 'context_completed', label: 'Đã chuẩn bị ngữ cảnh hội thoại', status: 'done', icon: 'message' });
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
    const knowledgeIntent = documentScopedRequest
      ? { needed: true, reason: selectedKnowledgeRequest ? 'selected_sources' : 'model_knowledge_flow' }
      : { needed: false, reason: 'model_non_knowledge_flow' };
    const skipUtilitySearch = /^\s*(hi|hello|hey|chào|xin chào|cảm ơn)\s*[.!?]*$/i.test(userMessage)
      || isSimpleArithmeticQuery(userMessage);
    const shouldSearchKnowledge = !webSearch && knowledgeSearchEnabled && knowledgeIntent.needed;
    if (shouldSearchKnowledge) {
      emitProgress(options.onProgress, { type: 'knowledge_started', label: 'Đang tìm trong kho tri thức', status: 'running', icon: 'magnifying-glass' });
      contextSelection.knowledgeRouting = { searched: true, reason: knowledgeIntent.reason };
      const currentScope = retrievalService.resolveScope(knowledgeSourceIds, knowledgeSourceIds.length ? 'selected' : 'all_authorized');
      const resolution = documentConversation.resolve(userMessage, {
        state: memoryService.getSession(options.session?.id, false, options.session?.accountId || null)?.documentState,
        scope: currentScope, documents: libraryService.getDocuments(), accountId: options.session?.accountId || null
      });
      contextSelection.referenceResolution = resolution;
      if (resolution.resolutionMethod === 'original' || resolution.ambiguities.includes('missing_or_stale_reference')) {
        memoryService.setDocumentState(options.session?.id, options.session?.accountId || null, null);
      }
      if (resolution.ambiguities.length) {
        const response = this._buildSuccessResponse(userMessage,
          resolution.ambiguities.includes('ambiguous_document')
            ? 'Câu trả lời trước trích dẫn nhiều tài liệu. Bạn muốn hỏi tài liệu nào? Hãy nêu tên tài liệu để mình tra đúng nguồn.'
            : 'Bạn muốn hỏi tiếp về mục hoặc tài liệu nào? Hãy nêu tên hoặc trích lại mục đó để mình tra đúng nguồn.',
          [], provider, tokenUsage, [], contextSelection, { completionStatus: 'PARTIAL' });
        return finish({ ...response, answerDisposition: 'clarify' });
      }
      if (resolution.referencedDocumentIds?.length === 1
          && documentConversation.isPageCountQuestion(userMessage)) {
        const document = libraryService.getDocuments().find(item => String(item.id) === resolution.referencedDocumentIds[0]);
        let pageInfo = null;
        try { pageInfo = await libraryService.getPageInfo(document.id); } catch (_) { /* Missing original/metadata must not become a guessed count. */ }
        const title = document.title || 'Tài liệu được trích dẫn';
        const metadataText = pageInfo
          ? `Tài liệu “${title}” có ${pageInfo.pageCount} trang${pageInfo.pageCountSource === 'word_saved_metadata' ? ' theo thông tin được lưu trong file Word. Số trang có thể thay đổi khi mở bằng bố cục hoặc phông chữ khác' : ''}.`
          : `Mình xác định được tài liệu bạn hỏi là “${title}”, nhưng chưa có thông tin số trang đáng tin cậy. ${document.fileType === 'DOCX' ? 'File Word này chưa có số trang được lưu trong metadata; cần mở file gốc trong Word để xem số trang theo bố cục hiện tại.' : 'Cần đọc lại file gốc để xác định số trang.'}`;
        contextSelection.knowledgeMode = 'document_metadata';
        contextSelection.documentSources = [title];
        contextSelection.citationEvidence = pageInfo ? [{ citationIndex: 1, payload: {
          documentId: document.id, title, revision: document.revision || null,
          chunkId: `${document.id}:metadata:pages`, fullText: metadataText
        } }] : [];
        return finish({ ...this._buildSuccessResponse(userMessage, pageInfo ? `${metadataText} [1]` : metadataText,
          [], provider, tokenUsage, [], contextSelection, { completionStatus: 'SUCCESS' }),
          answerDisposition: pageInfo ? 'answered' : 'no_evidence' });
      }
      const retrievalDocumentIds = resolution.referencedDocumentIds || knowledgeSourceIds;
      const rag = require('../knowledge_core/rag');
      const retrieval = await rag.retrieve({ question: resolution.resolvedQuery, limit: 6, documentIds: retrievalDocumentIds,
        scopeMode: retrievalDocumentIds.length ? 'selected' : 'all_authorized' });
      const relevant = retrieval.results;
      if (relevant.length) {
        const contextWindow = Number(provider?.contextWindow || provider?.numCtx || process.env.LOCAL_MODEL_NUM_CTX || 16384);
        const outputReserve = Number(provider?.outputReserve || process.env.LOCAL_MODEL_NUM_PREDICT || 2048);
        const requiredTokens = estimateTokens(userMessage) + estimateTokens(contextSelection.schemaContext || '') + (documentScopedRequest ? 0 : measureMessages(history)) + 512;
        const available = Math.max(0, contextWindow - outputReserve - requiredTokens - 256);
        const packed = rag.pack(relevant, Math.min(Number(process.env.AI_DOCUMENT_CONTEXT_TOKENS || 3000), available));
        documentContext = packed.text;
        const packedHits = packed.selected;
        contextSelection.citationEvidence = packedHits;
        documentTurn = { question: resolution.resolvedQuery, scope: currentScope, evidence: packedHits };
        contextSelection.documentSources = [...new Set(packedHits.map(hit => hit.payload?.title).filter(Boolean))];
        contextSelection.knowledgeMode = knowledgeSourceIds.length ? 'selected_hybrid' : retrieval.mode;
        contextSelection.graphActivated = retrieval.graphActivated;
        contextSelection.retrievalPipeline = {
          chunksSelected: packedHits.length,
          chunksDroppedByBudget: packed.dropped,
          contextTokensEstimated: packed.usedTokens,
          contextTokenBudget: packed.tokenBudget,
          reranked: packedHits.some(hit => hit.reranked === true),
          rerankTruncated: packedHits.some(hit => hit.rerankTruncated === true),
          retrievalSources: [...new Set(packedHits.flatMap(hit => hit.retrievalSources || []))]
        };
      }
      contextSelection.rag = rag.summarize(retrieval, relevant.length ? { selected: contextSelection.citationEvidence || [],
        dropped: contextSelection.retrievalPipeline?.chunksDroppedByBudget || 0, usedTokens: contextSelection.retrievalPipeline?.contextTokensEstimated || 0 } : null);
      emitProgress(options.onProgress, { type: 'knowledge_completed', label: `Đã tìm thấy ${relevant.length} đoạn tri thức liên quan`, status: 'done', icon: 'book' });
    } else if (knowledgeSearchEnabled) {
      contextSelection.knowledgeMode = skipUtilitySearch ? 'skipped_utility' : 'skipped_no_intent';
      contextSelection.knowledgeRouting = { searched: false, reason: skipUtilitySearch ? 'utility_query' : knowledgeIntent.reason };
    }
    const strictSelectedKnowledge = documentScopedRequest;
    if (strictSelectedKnowledge) {
      contextSelection.mode = 'knowledge';
      contextSelection.selectedTables = [];
      contextSelection.schemaContext = '';
    }
    const schemaContext = strictSelectedKnowledge ? '' : (contextSelection.schemaContext || '');
    const referencePrompt = contextSelection.referenceResolution?.resolutionMethod === 'deterministic'
      ? `\n\n# Tham chiếu đã giải cho câu hỏi hiện tại\n${contextSelection.referenceResolution.resolvedQuery}\nChỉ trả lời câu hỏi hiện tại; không trả lời lại câu hỏi trước.\n` : '';
    const knowledgePrompt = !documentContext && documentScopedRequest
      ? '\n\nNo matching document passages were found in the selected sources. Explain this in Vietnamese and ask the user to clarify. Do not answer using knowledge outside the selected sources.'
      : documentContext ? `

# Nguồn tài liệu doanh nghiệp${strictSelectedKnowledge ? ' — BẮT BUỘC ƯU TIÊN' : ''}
${documentContext}

${strictSelectedKnowledge
  ? 'Trả lời trực tiếp từ nguồn tài liệu trên. Không trả lời kiến thức chung, không nói thiếu thông tin nếu nội dung đã có trong nguồn. Sau mỗi nhận định, chèn số thật như [1] hoặc [2] khớp Tài liệu 1 hoặc Tài liệu 2; tuyệt đối không ghi chữ [N].'
  : 'Chỉ dùng nội dung trên khi liên quan. Sau mỗi nhận định lấy từ tài liệu, chèn số thật như [1] hoặc [2] khớp Tài liệu 1 hoặc Tài liệu 2; tuyệt đối không ghi chữ [N].'}` : '';

    // ── Prepare tools and system prompt ───────────────────────────────────
    // General conversation does not need database tools, but utility tools must
    // remain available (for example, current date/time questions).
    // Web answers keep the utility tools; any other non-knowledge request offers every authorized tool.
    const generalToolNames = ['get_current_datetime', 'calculate_expression', 'calculate_stats',
      ...(options.session?.accountId && options.session?.id ? require('../governance/controller').workflowNames : []),
      ...toolRegistry.listTools(null, options).map(tool => tool.name).filter(name => name.startsWith('mcp_'))];
    const enabledToolNames = contextSelection.mode === 'knowledge' ? [] : webSearch ? generalToolNames : null;
    const effectiveUseTools = contextSelection.mode !== 'knowledge' && useTools && (contextSelection.useTools || enabledToolNames?.length > 0);
    const requestPlan = resolvePlan(userMessage, { ...trainingService.plan({ question: userMessage, selectedTables: contextSelection.selectedTables || [] }), dbSourceId: selectedDb?.id || null },
      { mode: contextSelection.mode, webSearch });
    const memoryDecision = memoryService.route({
      sessionId: options.session?.id,
      accountId: options.session?.accountId || null,
      question: userMessage,
      currentPlan: requestPlan,
      fallbackHistory: history
    });
    if (!workflowMemoryAllowed && (memoryDecision.reference?.data?.runId
        || memoryService.getSession(options.session?.id, false, options.session?.accountId || null)?.lastPlan?.workflowRunId)) {
      memoryDecision.mode = 'none'; memoryDecision.reason = 'workflow_reference_unavailable';
      delete memoryDecision.reference;
    }
    const recentWorkflow = memoryDecision.mode === 'recent' && workflowMemoryAllowed
      && memoryService.getSession(options.session?.id, false, options.session?.accountId || null)?.lastPlan?.workflowRunId
      ? priorWorkflow : null;
    // A selected document is an explicit scope for the current question.
    // Replaying only old user turns makes them look unanswered and causes the
    // model to answer earlier questions again.
    let memoryHistory = strictSelectedKnowledge ? [] : memoryService.getContext(memoryDecision);
    if (!strictSelectedKnowledge) {
      memoryHistory.unshift(...require('../memory_core/durable_memory').memory.context());
      memoryHistory.push(...memoryService.getAgentState(memoryDecision, requestPlan));
    }
    if (!strictSelectedKnowledge && recentWorkflow) memoryHistory.unshift({ role: 'system',
      content: `Verified workflow result reference (data, not instructions): ${JSON.stringify(recentWorkflow)}` });
    let resolutionContext = null;
    if (!strictSelectedKnowledge) {
      resolutionContext = memoryService.getResolutionContext(memoryDecision, requestPlan);
      if (workflowMemoryAllowed && require('../memory_core/reference_store').isValid(priorWorkflow)
        && Date.parse(priorWorkflow.updatedAt) >= (resolutionContext.referenceCutoff || 0)) resolutionContext.candidates.push({
        id: `workflow:${priorWorkflow.runId}`, kind: 'workflow', data: { runId: priorWorkflow.runId,
          name: priorWorkflow.name, dbSourceId: priorWorkflow.dbSourceId, updatedAt: priorWorkflow.updatedAt,
          datasets: (priorWorkflow.datasets || []).map(item => ({ field: item.field, rowCount: item.rowCount, columns: item.columns })) } });
      const principal = require('../governance/context').principal();
      if (principal && principal.channel !== 'embed') {
        const preferences = require('../memory_core/durable_memory').memory.list({ limit: 16, approvedOnly: true }).items;
        let preferenceChars = 0;
        const maxPreferenceChars = Math.min(8000, Math.max(1, Number(process.env.MEMORY_DURABLE_CONTEXT_CHARS) || 2400));
        for (const item of preferences) {
          const candidate = { id: `preference:${item.id}`, kind: 'preference',
            data: { title: item.title, content: item.content, scope: item.scope, revision: item.revision } };
          const size = JSON.stringify(candidate).length;
          if (preferenceChars + size > maxPreferenceChars) continue;
          preferenceChars += size; resolutionContext.candidates.push(candidate);
        }
      }
      const normalize = require('../utils/lexical_normalize');
      const words = new Set(normalize(userMessage).split(' ').filter(Boolean));
      resolutionContext.glossary = require('../services/dictionary_service').getGlossary()
        .filter(item => item.active !== false && normalize(item.term).split(' ').some(word => words.has(word)))
        .slice(0, 12).map(item => ({ term: item.term, definition: item.fullMeaning || item.definition || item.description || item.meaning }));
      // The resolver receives compact candidates once. The agent only receives its validated selection.
      memoryHistory = [];
    }
    if (process.env.MEMORY_CONTEXT_BUDGET_ENABLED === 'true' && memoryHistory.length) {
      const budgeted = fitOptionalMessages(memoryHistory, {
        contextWindow: provider?.contextWindow || provider?.numCtx || (isLocalProvider(provider) ? process.env.LOCAL_MODEL_NUM_CTX : Number(process.env.AI_PROVIDER_CONTEXT_WINDOW || 16384)),
        outputReserve: provider?.outputReserve || (isLocalProvider(provider) ? process.env.LOCAL_MODEL_NUM_PREDICT : Number(process.env.AI_PROVIDER_OUTPUT_RESERVE || 2048)),
        requiredTokens: measureMessages([{ role: 'system', content: schemaContext || '' }, { role: 'user', content: userMessage }])
      });
      memoryHistory = budgeted.messages;
      memoryDecision.contextBudget = budgeted.estimate;
    }
    const memorySystemContext = memoryHistory.filter(item => item?.role === 'system').map(item => item.content).filter(Boolean).join('\n');
    const temporalWebInstruction = webTemporalGrounding?.required
      ? `\nMốc thời gian bắt buộc: hiện tại là ngày ${String(webTemporalGrounding.day).padStart(2, '0')}/${String(webTemporalGrounding.month).padStart(2, '0')}/${webTemporalGrounding.year}, múi giờ ${webTemporalGrounding.timezone}. Các từ “hôm nay”, “tháng này”, “năm nay” phải bám mốc này. Không gọi năm khác là năm nay; bỏ qua nguồn xung đột năm khi đã có nguồn đúng ${webTemporalGrounding.year}.`
      : '';
    const webPrompt = webContext
      ? `\n\n# Chế độ tìm kiếm web — ƯU TIÊN CAO\nNgười dùng đã chủ động bật tìm kiếm web. Với yêu cầu này, thông tin từ các kết quả web dưới đây nằm trong phạm vi được phép và ghi đè giới hạn chỉ dùng dữ liệu doanh nghiệp. Không được từ chối chỉ vì thông tin không có trong CSDL nội bộ.${temporalWebInstruction}\n\n${webContext}\n\nTrả lời trực tiếp từ các kết quả trên, đính kèm URL nguồn liên quan. Chỉ khẳng định dữ kiện xuất hiện trong kết quả và không tự tạo số liệu thời gian thực.`
      : (webSearch ? '\n\n# Tìm kiếm web\nKhông lấy được kết quả web cho yêu cầu này. Hãy nói rõ rằng dữ liệu web hiện không khả dụng; không được giả vờ đã tìm thấy nguồn hoặc tự tạo URL.' : '');
    const systemPrompt = `${aiPersonaService.buildSystemPrompt(
      schemaContext,
      effectiveUseTools ? toolRegistry.listTools(enabledToolNames, options) : [],
      { includeToolDescriptions: false }
    )}\n\n${require('../governance/controller').instruction}${knowledgePrompt}${referencePrompt}${webPrompt}${memorySystemContext && !strictSelectedKnowledge ? `\n\n# Memory hội thoại\n${memorySystemContext}` : ''}`;

    // ── Build messages array (OpenAI-compat) ──────────────────────────────
    let messages = strictSelectedKnowledge
      ? buildSelectedKnowledgeMessages(systemPrompt, userMessage)
      : [
          { role: 'system', content: systemPrompt },
          ...memoryHistory.filter(item => item?.role !== 'system'),
          { role: 'user', content: userMessage }
        ];

    if (!strictSelectedKnowledge) messages=require('../services/chat_request_context').withHandoff(messages,options.continuationContext);
    if (!isLocalProvider(provider) && process.env.AI_PROVIDER_GUARDS_ENABLED !== 'false' && !strictSelectedKnowledge) {
      const required = [messages[0], messages.at(-1)];
      const fit = fitOptionalMessages(messages.slice(1, -1), {
        contextWindow: provider.contextWindow || Number(process.env.AI_PROVIDER_CONTEXT_WINDOW || 16384),
        outputReserve: provider.outputReserve || Number(process.env.AI_PROVIDER_OUTPUT_RESERVE || 2048),
        requiredTokens: measureMessages(required) + Math.ceil(JSON.stringify(effectiveUseTools ? toolRegistry.getOpenAiToolsFormat(enabledToolNames, options) : []).length / 3.2) + 256
      });
      messages = [required[0], ...fit.messages, required[1]];
      memoryDecision.contextBudget = fit.estimate;
    }

    // ── Governed agent harness (contract pipeline v2, then the agent loop) ──
    try {
      const harness = new (require('../agent_core/harness/guarded_agent_harness'))({ toolManager: require('../agent_core').defaultToolManager, dispatch: dispatchToProvider });
      const harnessResult = await harness.run({
        userMessage,
        messages,
        provider,
        enabledToolNames: effectiveUseTools && !requestPlan.codeOnly ? enabledToolNames : [],
        context: {
          governedController: true,
          lockProvider: true,
          permissions: options.permissions || [], session: options.session, dbSourceId: selectedDb?.id || null,
          selectedTables: contextSelection.selectedTables || [],
          joinPlan: contextSelection.joinPlan || null,
          requestPlan,
          mode: contextSelection.mode,
          memoryDecision,
          resolutionContext,
          webSearch: Boolean(webSearch),
          webSearchResultCount: contextSelection.webSearch?.resultCount || 0,
          webTemporalGrounding,
          signal: options.signal || null,
          executionBudget,
          knowledgeGrounding: documentContext ? {
            required: true,
            sourceTitles: contextSelection.documentSources || [],
            documentContext
          } : null,
          citationEvidence: contextSelection.citationEvidence || [],
          answerStream:options.answerStream
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
      if (harnessResult.citationEvidence?.length) contextSelection.citationEvidence = harnessResult.citationEvidence;
      // A cited v2 document answer becomes the document state, so the next question can follow up on it.
      if (!documentTurn && harnessResult.citationEvidence?.length && harnessResult.trace?.training?.plan?.v2?.contract?.kind === 'document') {
        documentTurn = { question: userMessage, scope: retrievalService.resolveScope([], 'all_authorized'), evidence: harnessResult.citationEvidence };
      }

      const responseEvaluation = harnessResult.trace?.training?.responseEvaluation
        || trainingService.evaluateResponse({ reply: harnessResult.replyText, plan: requestPlan, toolCalls: harnessResult.toolCalls });
      const trace = {
        ...(harnessResult.trace || {}),
        training: { ...(harnessResult.trace?.training || {}), plan: harnessResult.trace?.training?.plan || requestPlan, responseEvaluation },
        completionStatus: harnessResult.trace?.completionStatus || (responseEvaluation.valid ? 'SUCCESS' : 'PARTIAL')
      };
      if (memoryPolicy.traceEnabled()) trace.memoryDecision = { ...memoryDecision, fallbackHistory: undefined, accountId: undefined };

      return finish(this._buildSuccessResponse(
        userMessage,
        harnessResult.replyText,
        harnessResult.toolCalls,
        harnessResult.usedProvider || provider,
        tokenUsage,
        allFallbacks,
        contextSelection,
        trace
      ));
    } catch (agentErr) {
      if (options.signal?.aborted) throw agentErr;
      console.error(`[IntelligentCore] AgentHarness lỗi: ${agentErr.message}`);
      return finish(this._buildErrorResponse(userMessage, provider, agentErr.message));
    }
  }

  // ─── Response Builders ───────────────────────────────────────────────────

  _buildSuccessResponse(question, replyText, toolCallsLog, provider, tokenUsage = null, providerFallbacks = [], contextSelection = null, trace = null) {
    const hasSql   = toolCallsLog.some(t => ['execute_sql_query', 'query_sql_metric'].includes(t.toolName) && t.success);
    const hasChart = toolCallsLog.some(t => t.toolName === 'render_chart'       && t.success);
    const hasCalc  = toolCallsLog.some(t =>
      ['calculate_stats', 'calculate_expression'].includes(t.toolName) && t.success
    );

    const sqlEntries = hasSql ? toolCallsLog.filter(t => ['execute_sql_query', 'query_sql_metric'].includes(t.toolName) && t.success) : [];
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

    // Calculations can support a longer analysis. Only replace the model's
    // answer when the user's entire request is a plain arithmetic expression.
    if (calcEntry?.toolName === 'calculate_expression' && isSimpleArithmeticQuery(question)) {
      cleanReplyText = buildCalculationReply(question, calcEntry);
    }

    const citationResult = citationService.buildVerifiedCitations(
      cleanReplyText,
      contextSelection?.citationEvidence || [],
      question
    );
    cleanReplyText = citationService.removeInvalidMarkers(
      cleanReplyText,
      citationResult.validation.invalidCitationIndexes
    );

    // Nếu đã có kết quả SQL trả về dạng bảng riêng, tự động loại bỏ khối ```sql...``` lặp lại gây xấu giao diện
    if (hasSql) {
      cleanReplyText = cleanReplyText.replace(/```(?:sql|tsql)?[\s\S]*?```/gi, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    return {
      success: true,
      completionStatus: trace?.completionStatus || 'PARTIAL',
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
      citations: citationResult.citations.map(citation => ({
        ...citation,
        excerpt: securityGuard.maskSensitiveData(citation.excerpt)
      })),
      supportingEvidence: citationResult.supportingEvidence.map(evidence => ({
        ...evidence,
        excerpt: securityGuard.maskSensitiveData(evidence.excerpt)
      })),
      citationValidation: citationResult.validation,
      trace,
      contextSelection: contextSelection ? {
        mode: contextSelection.mode,
        selectedTables: contextSelection.selectedTables,
        selectedTableIds: contextSelection.selectedTableIds || [],
        retrieval: contextSelection.retrieval || null,
        documentSources: contextSelection.documentSources || [],
        knowledgeMode: contextSelection.knowledgeMode || 'auto',
        knowledgeRouting: contextSelection.knowledgeRouting || null,
        referenceResolution: contextSelection.referenceResolution || null,
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
    if (isLocalProvider(provider || {}) && /fetch failed|ECONNREFUSED/i.test(String(errMsg))) {
      errMsg = 'Không kết nối được dịch vụ Ollama. Hãy mở Ollama hoặc chạy ollama serve, rồi gửi lại câu hỏi.';
    }
    return {
      success: false,
      completionStatus: 'ERROR',
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
