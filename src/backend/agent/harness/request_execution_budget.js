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
    this.maxTokens = positiveNumber(options.maxTokens, positiveNumber(process.env.GOVERNED_REQUEST_MAX_TOKENS, 128000));
    this.finalizeTokens = Math.min(this.maxTokens, positiveNumber(options.finalizeTokens, 2048));
    this.maxCost = positiveNumber(options.maxCost, positiveNumber(process.env.GOVERNED_REQUEST_MAX_COST, Infinity));
    this.tokens = 0; this.cost = 0; this.reservations = new Map(); this.nextReservation = 0;
  }

  reserveUsage({ tokens = 0, cost = 0, purpose = 'work' } = {}) {
    this.assertTimeRemaining();
    if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(cost) || cost < 0) throw new Error('INVALID_USAGE_RESERVATION');
    const pending = [...this.reservations.values()].reduce((sum, item) => ({ tokens: sum.tokens + item.tokens, cost: sum.cost + item.cost }), { tokens: 0, cost: 0 });
    if (this.tokens + pending.tokens + tokens > this.maxTokens - (purpose === 'finalize' ? 0 : this.finalizeTokens)) throw Object.assign(new Error('Token budget exhausted.'), { code: 'TOKEN_BUDGET_EXCEEDED' });
    if (this.cost + pending.cost + cost > this.maxCost) throw Object.assign(new Error('Estimated cost budget exhausted.'), { code: 'COST_BUDGET_EXCEEDED' });
    const id = ++this.nextReservation; this.reservations.set(id, { tokens, cost }); return id;
  }

  reconcileUsage(id, actual = {}) {
    const estimate = this.reservations.get(id);
    if (!estimate) throw new Error('UNKNOWN_USAGE_RESERVATION');
    this.reservations.delete(id);
    this.tokens += Number.isFinite(actual.tokens) && actual.tokens >= 0 ? actual.tokens : estimate.tokens;
    this.cost += Number.isFinite(actual.cost) && actual.cost >= 0 ? actual.cost : estimate.cost;
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
      , tokens: this.tokens, maxTokens: this.maxTokens, cost: this.cost, maxCost: Number.isFinite(this.maxCost) ? this.maxCost : null,
      pendingReservations: this.reservations.size, finalizeTokens: this.finalizeTokens
    };
  }
}

module.exports = { RequestExecutionBudget };
