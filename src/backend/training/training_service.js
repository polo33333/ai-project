'use strict';

const dictionaryService = require('../services/dictionary_service');
const { createRequestPlan } = require('./request_planner');
const { evaluateSql } = require('./sql_evaluator');
const { evaluateResponse } = require('./response_evaluator');
const { requirementsFor } = require('./policy_registry');

class TrainingService {
  plan(input = {}) {
    const plan = createRequestPlan({ ...input, dictionaryTables: input.dictionaryTables || dictionaryService.getGroupedTables() });
    return { ...plan, requirements: requirementsFor(plan) };
  }

  evaluateSql(sql, plan) { return evaluateSql(sql, plan); }
  evaluateResponse(input) { return evaluateResponse(input); }
}

module.exports = new TrainingService();
