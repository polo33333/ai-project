'use strict';

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class RequestExecutionBudget {
  constructor(options = {}) {
    this.executionClass = options.executionClass || 'local';
    this.toolCalls = 0;
    this.maxToolCalls = positiveNumber(options.maxToolCalls, 20);
    const timeoutMs = positiveNumber(options.timeoutMs, positiveNumber(process.env.AI_LOCAL_TIMEOUT_MS, 180000));
    this.startedAt = options.startedAt || Date.now();
    this.deadlineAt = options.deadlineAt || this.startedAt + timeoutMs;
    this.maxModelCalls = positiveNumber(options.maxModelCalls, positiveNumber(process.env.LOCAL_MODEL_MAX_MODEL_CALLS, 9));
    this.maxSqlAttempts = positiveNumber(options.maxSqlAttempts, positiveNumber(process.env.LOCAL_MODEL_MAX_SQL_CALLS, 3));
    this.modelCalls = 0;
    this.sqlAttempts = 0;
    this.repairAttempts = 0;
  }

  remainingMs(now = Date.now()) {
    return Math.max(0, this.deadlineAt - now);
  }

  assertTimeRemaining() {
    if (this.remainingMs() <= 0) {
      const error = new Error('Request deadline exceeded.');
      error.code = this.executionClass === 'local' ? 'LOCAL_REQUEST_DEADLINE_EXCEEDED' : 'REQUEST_DEADLINE_EXCEEDED';
      throw error;
    }
  }

  consumeModelCall() {
    this.assertTimeRemaining();
    if (this.modelCalls >= this.maxModelCalls) {
      const error = new Error(`Model call budget (${this.maxModelCalls}) is exhausted.`);
      error.code = this.executionClass === 'local' ? 'LOCAL_MODEL_CALL_BUDGET_EXCEEDED' : 'MODEL_CALL_BUDGET_EXCEEDED';
      throw error;
    }
    this.modelCalls += 1;
  }

  consumeSqlAttempt() {
    this.assertTimeRemaining();
    if (this.sqlAttempts >= this.maxSqlAttempts) {
      const error = new Error(`SQL attempt budget (${this.maxSqlAttempts}) is exhausted.`);
      error.code = 'SQL_BUDGET_EXCEEDED';
      throw error;
    }
    this.sqlAttempts += 1;
  }

  refundSqlAttempt() {
    this.sqlAttempts = Math.max(0, this.sqlAttempts - 1);
  }

  recordRepair() {
    this.repairAttempts += 1;
  }

  consumeToolCall() {
    this.assertTimeRemaining();
    if (this.toolCalls >= this.maxToolCalls) {
      const error = new Error(`Tool call budget (${this.maxToolCalls}) is exhausted.`);
      error.code = 'TOOL_BUDGET_EXCEEDED';
      throw error;
    }
    this.toolCalls += 1;
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      remainingMs: this.remainingMs(),
      modelCalls: this.modelCalls,
      maxModelCalls: this.maxModelCalls,
      sqlAttempts: this.sqlAttempts,
      maxSqlAttempts: this.maxSqlAttempts,
      repairAttempts: this.repairAttempts,
      toolCalls: this.toolCalls, maxToolCalls: this.maxToolCalls
    };
  }
}

module.exports = { RequestExecutionBudget };
