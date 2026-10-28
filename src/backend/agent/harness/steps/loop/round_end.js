'use strict';

// After a round without failures, decides whether the verified evidence
// already answers the request: schema description, code-computed analysis,
// a chart or grouped export ready for the output step, or a verified read.
// Returns { reply } to answer, { stop: true } to leave the loop, or null.
const { buildSqlRowsFallbackReply, qualifiedSql, evaluateCompletion, assessRequestContract } = require('../common');
const { hasTool } = require('./backend_calls');

async function completeRound(s, roundFailures) {
  const { question, context, plan, toolDefs, cachedCatalog, trace, toolCalls, dispatch } = s;
  if (context.governedController && plan.intent === 'schema_description' && !context.knowledgeGrounding?.required && !roundFailures.length) {
    const schema = toolCalls.filter(call => call.toolName === 'search_schema' && call.success).at(-1);
    const description = require('../../schema_description').renderSchemaDescription(schema?.result, plan.conversationState?.requestedAttributes);
    if (description) {
      const synthesis = await dispatch([], [
        { role: 'system', content: require('../../visible_answer').instruction + ' Answer the current question using only the supplied authorized schema metadata. Explain relevant configured fields in business language; do not dump all fields for a question about classification criteria. Distinguish available classification fields from actual category values: do not invent labels for TypeID, CustomerGroupID or StageID when their descriptions do not define them. No record SQL is needed for explaining available criteria. Never infer database values or product features from field names alone. Existing table columns do not prove supported search filters. For questions about required lookup inputs, use the authorized workflow input definitions supplied alongside schema; otherwise state that required lookup inputs cannot be confirmed from schema alone. Return only the final answer.' },
        { role: 'user', content: JSON.stringify({ question, schema: require('../../agent_context').packExecution('search_schema', schema).result.tables,
          workflows: cachedCatalog || toolCalls.filter(call => call.toolName === 'list_workflows' && call.success).flatMap(call => call.result?.workflows || []) }) }
      ], 'schema_description_synthesis');
      const candidate = require('../../visible_answer').visibleAnswer(synthesis.content);
      const assessment = evaluateCompletion({ reply: candidate, plan, toolCalls, context, finishReason: synthesis.finish_reason });
      if (assessment.valid) {
        trace.steps.push({ type: 'VERIFIED_SCHEMA_DESCRIPTION', iteration: trace.iterations });
        return { reply: candidate };
      }
    }
  }
  if (roundFailures.length) return null;
  const verified = qualifiedSql(toolCalls, plan).at(-1);
  const emptyAnalysis = require('../../analysis_response').emptyReply(verified, plan);
  if (emptyAnalysis) {
    trace.steps.push({ type: 'ANALYSIS_NO_MATCHING_DATA' });
    return { reply: emptyAnalysis };
  }
  const shortAnalysis = require('../../analysis_response').shortAnomalyReply(verified, plan);
  if (shortAnalysis) {
    trace.steps.push({ type: 'ANALYSIS_INSUFFICIENT_HISTORY', observedMonths: verified.result.rows.length });
    return { reply: shortAnalysis };
  }
  // Longer series: the verdict comes from the code-computed AnalysisResult.
  const seriesAnalysis = require('../../analysis_response').seriesAnomalyReply(verified, plan, question);
  if (seriesAnalysis) {
    trace.analysisResult = { ...seriesAnalysis.result, scores: undefined };
    trace.steps.push(seriesAnalysis.result.verdict === 'INSUFFICIENT_DATA'
      ? { type: 'ANALYSIS_INSUFFICIENT_HISTORY', observedMonths: seriesAnalysis.result.observations }
      : { type: 'ANALYSIS_COMPUTED', method: seriesAnalysis.result.methodId, verdict: seriesAnalysis.result.verdict });
    return { reply: seriesAnalysis.text };
  }
  if (plan.outputs?.chart && !plan.outputs.export && verified?.result?.rows?.length
    && hasTool(toolDefs, 'render_chart')
    && !toolCalls.some(call => call.toolName === 'render_chart' && call.success)
    && (!plan.requestContract || assessRequestContract(plan.requestContract, verified).complete)) {
    trace.steps.push({ type: 'CHART_OUTPUT_READY', iteration: trace.iterations });
    return { stop: true };
  }
  if (plan.outputs?.export && plan.exportRequest.separate && verified
    && (!plan.requestContract || assessRequestContract(plan.requestContract, verified).complete)
    && require('../../group_exports').groups(plan, toolCalls).length) {
    trace.steps.push({ type: 'GROUP_EXPORT_OUTPUT_READY' });
    return { stop: true };
  }
  if (context.governedController && (!plan.semanticGroups||require('../../semantic_groups').results(plan.semanticGroups,toolCalls,call=>require('../../completion_policy').assessSqlEvidence(call,plan)?.accepted).every(g=>g.complete)) && require('../../completion_policy').canFinalizeVerifiedRead(plan, verified, context)) {
    trace.steps.push({ type: 'VERIFIED_READ_COMPLETE', iteration: trace.iterations });
    return { reply: buildSqlRowsFallbackReply(verified, plan.columnDisplayNames, { forceTable: plan.presentation === 'table', comparison: plan.conversationState?.operation === 'compare', displayIdentityColumns: plan.displayIdentityColumns, resultGroupBy: plan.resultGroupBy }) };
  }
  return null;
}

module.exports = { completeRound };
