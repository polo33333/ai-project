'use strict';

// The verified answer: grounded rendering, output links, completion
// evaluation, scope notes and the run result.
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');

async function finalizeAnswer(s) {
  const { harness, userMessage, provider, enabledToolNames, resourceSnapshot, question, messages, context, onProgress, budget, candidates, plan, requestTime, resultStore, toolContext, toolDefs,
    cachedCatalog, pendingInput, policy, instruction, conversation, trace, toolCalls, providerFallbacks, seen, check, dispatch } = s;
  let { reply, finishReason, stopReason } = s;
  try {
    const sql = qualifiedSql(toolCalls, plan).at(-1);
    trace.sqlEvidence = toolCalls.map((call, index) => ({ index, toolName: call.toolName,
      assessment: require('../completion_policy').assessSqlEvidence(call, plan) })).filter(item => item.assessment);
    // Retain a verified empty result even if a later optional tool/repair fails.
    const emptyAnalysis = require('../analysis_response').emptyReply(sql, plan);
    if (emptyAnalysis) {
      reply = emptyAnalysis; finishReason = undefined;
      if (!trace.steps.some(step => step.type === 'ANALYSIS_NO_MATCHING_DATA')) trace.steps.push({ type: 'ANALYSIS_NO_MATCHING_DATA' });
    }
    if (plan.requestContract) trace.contractAssessment = assessRequestContract(plan.requestContract, sql);
    // Render lists from executed rows so a fluent but truncated model answer cannot omit records.
    if (sql && !require('../analysis_response').task(plan) && (!reply || plan.schemaScope?.filters?.length || plan.presentation === 'table' || ['detail', 'attribute', 'aggregate'].includes(plan.requestContract?.operation)
      || (context.governedController ? plan.intent === 'list' : ['list', 'record_lookup'].includes(plan.intent)) || sql.result.rows.length === 0)) {
      const citedMarkers = require('../../../knowledge/services/citation_service').findMarkers(reply || '');
      const knownMarkers = new Set([...(context.citationEvidence || []), ...toolCalls.filter(call => call.success && call.toolName === 'search_knowledge_base')
        .flatMap(call => call.result?.documents || [])].map(item => item.citationIndex));
      const retainedMarkers = [...new Set(citedMarkers.filter(marker => knownMarkers.has(marker)))];
      reply = buildSqlRowsFallbackReply({ ...sql, result: { ...sql.result, rows: security.sanitizeTabularRows(sql.result.rows) } }, plan.columnDisplayNames,
        { forceTable: plan.presentation === 'table' || plan.requestContract?.presentation === 'table', comparison: plan.conversationState?.operation === 'compare', displayIdentityColumns: plan.displayIdentityColumns, resultGroupBy: plan.resultGroupBy });
      if (retainedMarkers.length) reply += `\n\nTài liệu đối chiếu: ${retainedMarkers.map(marker => `[${marker}]`).join(' ')}.`;
      finishReason = undefined;
      trace.steps.push({ type: 'GROUNDED_RESULT_RENDER' });
    }
    if(plan.semanticGroups)reply=require('../semantic_groups').render(plan.semanticGroups,toolCalls,(call,names)=>buildSqlRowsFallbackReply({...call,result:{...call.result,rows:security.sanitizeTabularRows(call.result.rows)}},names),plan.columnDisplayNames,call=>require('../completion_policy').assessSqlEvidence(call,plan)?.accepted);
    const exported = toolCalls.find(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
    const chart = toolCalls.find(call => call.toolName === 'render_chart' && call.success && call.result?.chartSpec);
    if (plan.outputs?.chart && !chart && sql) reply += '\n\nĐã lấy được số liệu, nhưng chưa tạo được biểu đồ. Vui lòng thử lại.';
    if (chart && plan.temporalMonths && chart.result.chartSpec.data?.labels?.length < plan.temporalMonths)
      reply = `${reply || 'Đã tạo biểu đồ từ dữ liệu hiện có.'}\n\nBiểu đồ hiện có ${chart.result.chartSpec.data.labels.length} mốc dữ liệu, chưa đủ ${plan.temporalMonths} tháng theo yêu cầu. Không tự điền số liệu cho các tháng còn thiếu.`;
    if (!reply && chart) reply = 'Đã tạo biểu đồ từ dữ liệu đã xác minh.';
    if (exported) {
      const exports = toolCalls.filter(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
      if (plan.exportRequest.separate) reply = exports.map(call => `- [${String(call.exportGroup || call.result.fileName).replace(/[\[\]]/g, '')}](${call.result.downloadUrl}) — ${call.result.recordCount ?? call.args.data.length} bản ghi`).join('\n');
      else reply = ensureDownloadLink(reply || 'Đã xuất file.', exported.result.downloadUrl);
      finishReason = undefined;
    }
    if (plan.exportRequest.separate && plan.groupExportFailures?.length) {
      const message = 'Chưa tạo đủ các file theo nhóm được yêu cầu. Các nhóm hoặc dữ liệu chưa được xác minh đầy đủ; chưa thể coi yêu cầu xuất file là hoàn tất.';
      reply = exported ? `${reply}\n\n${message}` : message;
    }
    if (!reply && !sql && toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success && Array.isArray(call.result?.rows))) {
      reply = 'Đã lấy được dữ liệu, nhưng kết quả chưa đáp ứng đầy đủ cách tính hoặc phạm vi yêu cầu. Chưa thể xác nhận câu trả lời từ kết quả này.';
    }
    if (!reply && plan.conversationState?.operation === 'aggregate' && !sql
      && toolCalls.some(call => call.success && call.toolName === 'search_schema')) {
      reply = 'Đã tra cứu cấu trúc dữ liệu, nhưng chưa thực hiện được truy vấn thống kê đã xác minh. Chưa có số liệu đủ căn cứ để trả lời yêu cầu này.';
    }
    if (!reply) {
      reply = require('../answer_status').fallbackReply(stopReason, toolCalls);
      trace.answerStatus = require('../answer_status').category(stopReason, toolCalls);
    }
    let evaluation = evaluateCompletion({ reply, plan, toolCalls, context, finishReason });
    if (plan.groupExportFailures?.length) evaluation = { valid: false, score: 0, failures: [...new Set([...evaluation.failures, ...plan.groupExportFailures])] };
    const analysisLimit = trace.steps.find(step => ['ANALYSIS_INSUFFICIENT_HISTORY', 'ANALYSIS_NO_MATCHING_DATA'].includes(step.type));
    if (analysisLimit) evaluation = {
      valid: false, score: evaluation.score, failures: [...new Set([...evaluation.failures, analysisLimit.type])]
    };
    if(!plan.semanticGroups&&plan.resultGroupBy?.length&&!require('../result_grouping').partition(sql,plan.resultGroupBy,plan.columnDisplayNames))evaluation={valid:false,score:0,failures:[...new Set([...evaluation.failures,'RESULT_GROUPING_UNRESOLVED'])]};
    if(plan.semanticGroups&&!require('../semantic_groups').results(plan.semanticGroups,toolCalls,call=>require('../completion_policy').assessSqlEvidence(call,plan)?.accepted).every(g=>g.complete))evaluation={valid:false,score:0,failures:[...new Set([...evaluation.failures,'REQUEST_GROUPS_NOT_QUERIED'])]};
    if (stopReason && !sql && !chart && !exported) {
      evaluation = { valid: false, score: 0, failures: [...new Set([...evaluation.failures, stopReason])] };
    }
    // A generic fallback must never turn a failed general/knowledge request into SUCCESS.
    if (reply.startsWith('Chưa thể hoàn tất') && evaluation.valid) evaluation = { valid: false, score: 0, failures: ['INCOMPLETE_ANSWER'] };
    // Rows filtered only by the qualifiers that were proven bound may be wider
    // than the question. Disclose that instead of reporting SUCCESS.
    // A missing/failed review matters only when the question carries a concrete
    // value (number or code) that could be such a qualifier.
    if (sql && plan.outputs?.data && (plan.requestFilterReview === 'unresolved'
      || (['missing', 'failed'].includes(plan.requestFilterReview) && /\d/.test(question) && !plan.requestFilters?.length))) {
      evaluation = { valid: false, score: evaluation.score, failures: [...new Set([...evaluation.failures, 'REQUEST_FILTERS_UNVERIFIED'])] };
      const unresolved = (plan.unresolvedRequestFilters || []).map(item => `“${item.evidence}”`);
      reply += unresolved.length
        ? `\n\n**Lưu ý phạm vi:** Chưa ánh xạ được điều kiện ${unresolved.join(', ')} vào cột dữ liệu được phép, nên kết quả trên có thể rộng hơn yêu cầu.`
        : '\n\n**Lưu ý phạm vi:** Chưa xác minh tự động được đầy đủ các điều kiện lọc trong câu hỏi. Hãy đối chiếu phạm vi của kết quả trước khi sử dụng.';
    }
    // Completion diagnostics belong to audit history, not the user-facing reply.
    trace.training.responseEvaluation = evaluation;
    trace.completionStatus = evaluation.valid ? 'SUCCESS' : 'PARTIAL';
    const keptFilters = (plan.inheritedFilters || []).filter(filter => plan.requestFilters?.includes(filter));
    if (sql && keptFilters.length) reply = `Giữ phạm vi từ câu trước: ${keptFilters.map(filter => `**${String(filter.value).replace(/[*_`]/g, '')}**`).join(', ')}.\n\n${reply}`;
    if (requestTime.relative && sql) {
      const [year, month, day] = requestTime.today.split('-');
      reply = `Tính đến **${day}/${month}/${year}** (giờ Việt Nam).\n\n${reply}`;
      if (requestTime.monthWindow) {
        const window = requestTime.monthWindow;
        const date = value => value.split('-').reverse().join('/');
        reply = `Phạm vi: **${date(window.start)} đến trước ${date(window.end)}** (${window.count} tháng lịch, gồm tháng hiện tại chưa kết thúc).\n\n${reply}`;
      }
      if (requestTime.horizonDays) reply += `\n\nPhạm vi “sắp đến hạn”: ${requestTime.horizonDays} ngày kể từ ngày tham chiếu, không gồm ngày cuối khoảng.`;
    }
    if (requestTime.needsHorizon) {
      const clarification = 'Bạn muốn xem “sắp đến hạn” trong bao nhiêu ngày tới? Hệ thống chưa có ngưỡng được xác định nên chưa kết luận cho nhóm này.';
      reply = sql ? `${reply}\n\n${clarification}` : clarification;
    }
    trace.executionBudget = budget.snapshot();
    trace.durationMs = Date.now() - trace.startTime;
    trace.stopReason = stopReason;
    // Same code with different flags guards JOINs differently; audits need both.
    trace.executionProfile = { governedController: Boolean(context.governedController),
      joinPlannerEnforced: process.env.SQL_JOIN_PLANNER_ENABLED === 'true',
      controllerMode: 'governed', maxRepairs: harness.maxRepairs };
    emitProgress(onProgress, { type: 'request_completed', label: evaluation.valid ? 'Đã hoàn thành câu trả lời' : 'Yêu cầu chưa hoàn tất', status: evaluation.valid ? 'done' : 'warning', icon: 'check', durationMs: trace.durationMs });
    const citationEvidence = [...(context.citationEvidence || []), ...toolCalls.filter(call => call.success && call.toolName === 'search_knowledge_base')
      .flatMap(call => (call.result?.documents || []).map(document => ({ citationIndex: document.citationIndex, payload: {
        documentId: document.documentId, chunkIndex: document.chunkIndex, chunkId: document.chunkId, revision: document.revision,
        title: document.source, fullText: document.text, page: document.page, section: document.section } })))];
    return { replyText: security.maskSensitiveData(reply), toolCalls, citationEvidence, usedProvider: s.activeProvider, providerFallbacks,
      tokenUsage: trace.tokenUsage, trace, conversation };
  } finally { Object.assign(s, { reply, finishReason, stopReason }); }
}

module.exports = { finalizeAnswer };
