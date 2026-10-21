'use strict';

// Versioned gateway result alongside the legacy success/result adapter.
// Unknown coverage/effects stay unknown; no automatic retries are introduced.
function createToolResult(execution, context = {}, tool = {}) {
  const data = execution.success === true ? execution.result ?? null : null;
  const run = data?.execution;
  let status = execution.success === true ? 'succeeded' : 'failed';
  if (execution.outcome === 'denied') status = 'denied';
  else if (execution.outcome === 'invalid_input') status = 'invalid_input';
  else if (execution.outcome === 'timeout') status = 'timeout';
  else if (execution.outcome === 'cancelled' || run?.status === 'CANCELLED') status = 'cancelled';
  else if (run?.status === 'FAILED') status = 'failed';
  else if (['CREATED', 'READY', 'RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL', 'NEEDS_REVIEW'].includes(run?.status)) status = 'pending';
  else if (execution.success === true && Array.isArray(data?.rows) && !data.rows.length) status = 'empty';
  const effectState = execution.effectState || (tool.isDangerous ? 'unknown' : 'none');
  const failed = ['failed', 'denied', 'invalid_input', 'timeout', 'cancelled'].includes(status);
  return {
    schemaVersion: '1', tool: execution.tool || tool.name || null, status, data,
    evidence: { sourceId: data?.dbSourceId || data?.sourceId || null,
      outputRef: data?.outputRef || null, observedAt: new Date().toISOString() },
    scope: { requestId: context.requestId || null, conversationId: context.session?.id || null },
    completeness: { status: execution.success !== true || ['pending', 'failed', 'cancelled'].includes(status) ? 'unknown'
      : data?.hasMore || data?.truncated ? 'partial' : data?.complete === true ? 'complete' : 'unknown' },
    revision: run?.revision ?? data?.sourceRevision ?? null,
    error: failed ? { code: execution.code || (status === 'failed' && run ? 'WORKFLOW_FAILED' : null),
      message: execution.error || run?.error || status,
      retryable: execution.retryable === true && effectState === 'none' && !tool.isDangerous
        && !['cancelled', 'denied', 'invalid_input'].includes(status) } : null,
    usage: { durationMs: execution.durationMs || 0 }, effectState,
    receipt: run?.id ? { runId: run.id, revision: run.revision ?? null, status: run.status } : null
  };
}

module.exports = { createToolResult };
