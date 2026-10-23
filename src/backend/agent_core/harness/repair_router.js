'use strict';

// Failure code -> phase, repair action and instruction. Phases are ordered as
// the pipeline runs; a failure set is repaired at its earliest phase, so a
// misunderstanding is fixed before output wording, and each phase spends its
// own budget instead of one shared counter.
const PHASES = ['stage', 'join', 'scope', 'fields', 'measure', 'execution', 'analysis', 'output', 'general'];

// Stage rejections already carry their exact correction in the tool result.
// They do not spend repair budget; iteration/model-call limits still bound them.
const STAGE = new Set(['TOOL_NOT_IN_STAGE', 'WORKFLOW_DISCOVERY_REQUIRED', 'SCHEMA_DISCOVERY_REQUIRED', 'SCHEMA_ALREADY_VERIFIED',
  'PREMATURE_OUTPUT_TOOL', 'INVALID_ARGUMENTS', 'SQL_PROJECTION_REQUIRED', 'NO_PROGRESS',
  // An unsuitable workflow redirects to SQL; its own assessment already ran.
  'WORKFLOW_ALREADY_REJECTED', 'WORKFLOW_OPERATION_MISMATCH', 'WORKFLOW_INPUT_FIELD_MISMATCH']);

function phaseOf(code) {
  if (STAGE.has(code)) return 'stage';
  if (/^JOIN_/.test(code)) return 'join';
  if (/FILTER|SCOPE|^TEMPORAL_|^FOLLOWUP_/.test(code)) return 'scope';
  if (/^CONTRACT_|UNKNOWN_COLUMN|MISSING_COLUMN|WRONG_TABLE|GROUPING|GROUPS_NOT_QUERIED/.test(code)) return 'fields';
  if (/WRONG_METRIC|AGGREGATION_REQUIRED|METRIC_UNVERIFIED|^CALCULATION_/.test(code)) return 'measure';
  if (/^SQL_(EXECUTION_FAILED|ROWS_UNAVAILABLE|SOURCE_MISMATCH)$|^TOOL_EXECUTION_FAILED$|^SEMANTIC_QUERY_|^INVALID_SQL$/.test(code)) return 'execution';
  if (/^ANALYSIS_/.test(code)) return 'analysis';
  if (/^MISSING_(CHART|EXPORT|SQL|KNOWLEDGE_CITATION)$|ANSWER$|ARTIFACT_LINK|OUTPUT_DATA|CITATION/.test(code)) return 'output';
  return 'general';
}

const INSTRUCTIONS = {
  stage: ' Follow the tool rejection detail exactly and use only the tools offered in this round.',
  join: ' Re-plan the JOIN from the tables the request needs: call get_join_path when available and use only verified relationship keys. For JOIN_GRAIN_UNSAFE aggregate each fact table separately at its own grain (subquery/CTE) before joining, or filter with EXISTS; never add DISTINCT or change the measure to pass. If no verified path exists, explain which relationship is missing instead of dropping the table or its filter.',
  scope: ' Restore every original predicate (entity codes, period, status, category, date bounds) in a new query. Never remove or widen a filter to make SQL run.',
  fields: ' Reconcile the unresolved request attributes against the permission-filtered schema already returned. Call search_schema with request.attributes using the exact exposed column names or configured businessRole names corresponding to the user criteria; preserve operation and presentation. Do not drop a user criterion, invent a column, or repeat the same final answer. If a criterion has no unambiguous exposed match, disclose that limitation.',
  measure: ' The SQL executed successfully but returned individual records for an aggregate request. Execute an aggregate query over the requested amount fields, preserving the verified customer/date predicates, source, and JOIN keys. Do not treat the first record as the total, sum a truncated preview, or repeat schema discovery. Only answer after the aggregate SQL succeeds.',
  execution: ' SQL execution and answer evidence are different states. Inspect the latest evidenceAssessment/tool error and correct only the failed invariant using the authorized schema already supplied. Keep all original user filters and outputs; never change source, remove a predicate, or invent fields to pass validation. Do not repeat an identical call or claim missing data merely because validation failed.',
  analysis: ' The answer asserts an anomaly without its criterion. State the method, reference baseline/threshold and the numeric comparison computed from the verified rows. If no approved or user-supplied criterion exists and history is insufficient, say that the anomaly cannot be confirmed instead of asserting one.',
  citation: ` Rewrite the answer from the supplied document context. After every document claim, insert the actual numbered marker such as [1] or [2], matching Tài liệu 1 or Tài liệu 2. Never output the literal text [N] and do not invent marker numbers. Use the document evidence already supplied in the system message.`
};

function route(failures = []) {
  const codes = [...new Set(failures)];
  const phases = [...new Set(codes.map(phaseOf))].sort((a, b) => PHASES.indexOf(a) - PHASES.indexOf(b));
  // Stage guidance only stays free when nothing else failed in the round.
  const phase = phases.find(item => item !== 'stage') || 'stage';
  const instructions = new Set();
  if (codes.includes('MISSING_KNOWLEDGE_CITATION')) instructions.add(INSTRUCTIONS.citation);
  if (codes.includes('CONTRACT_ATTRIBUTES_UNRESOLVED')) instructions.add(INSTRUCTIONS.fields);
  if (codes.includes('SQL_AGGREGATION_REQUIRED')) instructions.add(INSTRUCTIONS.measure);
  if (codes.some(code => /^SQL_(?:PLAN_|SCOPE_|SOURCE_|ROWS_|EXECUTION_)/.test(code))) instructions.add(INSTRUCTIONS.execution);
  if (codes.includes('ANALYSIS_CRITERION_MISSING')) instructions.add(INSTRUCTIONS.analysis);
  if (phases.includes('join')) instructions.add(INSTRUCTIONS.join);
  if (phases.includes('scope')) instructions.add(INSTRUCTIONS.scope);
  if (phase === 'stage') instructions.add(INSTRUCTIONS.stage);
  return { phase, phases, codes, free: phase === 'stage', instruction: [...instructions].join('') };
}

// A repair that leaves exactly the same failures open made no progress.
function signature(failures = []) { return [...new Set(failures)].sort().join('|'); }

module.exports = { route, phaseOf, signature, PHASES };
