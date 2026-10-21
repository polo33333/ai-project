'use strict';
const Ajv = require('ajv');
const blocks = ['E1', 'E2', 'E3', 'E4'];
const groups = ['accented', 'unaccented', 'abbreviation', 'compound', 'typo', 'reference'];
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', uniqueItems: true, items: string };
const schema = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'snapshot', 'policy', 'labels', 'observations'], properties: {
  schemaVersion: { const: '1' },
  snapshot: { type: 'object', additionalProperties: false, required: ['sourceRevision', 'modelRevision', 'configRevision', 'principalRef'],
    properties: Object.fromEntries(['sourceRevision', 'modelRevision', 'configRevision', 'principalRef'].map(name => [name, string])) },
  policy: { type: 'object', additionalProperties: false, required: ['minLabelsPerBlock', 'k', 'margin', 'alpha'], properties: {
    minLabelsPerBlock: { type: 'integer', minimum: 1 }, k: { type: 'integer', minimum: 1 },
    margin: { type: 'number', minimum: 0, maximum: 1 }, alpha: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 }
  } },
  labels: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['caseId', 'block', 'groupId', 'languageGroup', 'split', 'query', 'sourceScope', 'expectedIds', 'expectedDisposition', 'reviewer', 'approvedAt'], properties: {
      caseId: string, block: { enum: blocks }, groupId: string, languageGroup: { enum: [...groups, null] }, split: { enum: ['dev', 'holdout'] },
      query: string, sourceScope: string, expectedIds: ids, expectedDisposition: { enum: ['retrieve', 'no_match', 'clarify'] },
      reviewer: { type: ['string', 'null'], minLength: 1 }, approvedAt: { type: ['string', 'null'] }
    } } },
  observations: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['caseId', 'runId', 'mode', 'candidateIds', 'rankedIds', 'disposition', 'latencyMs', 'embeddingCalls', 'qdrantCalls', 'safety'], properties: {
      caseId: string, runId: string, mode: { enum: ['on', 'off'] }, candidateIds: ids, rankedIds: ids,
      disposition: { enum: ['retrieve', 'no_match', 'clarify'] }, latencyMs: { type: 'number', minimum: 0 },
      embeddingCalls: { type: 'integer', minimum: 0 }, qdrantCalls: { type: 'integer', minimum: 0 },
      tokens: { type: ['integer', 'null'], minimum: 0 }, errorCode: { type: ['string', 'null'] },
      safety: { type: 'object', additionalProperties: false, required: ['permission', 'injection', 'noFabrication'],
        properties: Object.fromEntries(['permission', 'injection', 'noFabrication'].map(name => [name, { enum: ['passed', 'failed', 'not_checked'] }])) }
    } } }
} };
const validate = new Ajv({ allErrors: true }).compile(schema);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;

function evaluate(input) {
  if (!validate(input)) throw Object.assign(new Error('RETRIEVAL_INPUT_INVALID'), { details: validate.errors });
  const byId = new Map();
  const splits = new Map();
  for (const label of input.labels) {
    if (byId.has(label.caseId)) throw new Error('RETRIEVAL_DUPLICATE_CASE');
    if ((label.expectedDisposition === 'retrieve') !== Boolean(label.expectedIds.length)) throw new Error('RETRIEVAL_LABEL_DISPOSITION_CONFLICT');
    if (label.approvedAt !== null && (!label.approvedAt.includes('T') || !Number.isFinite(Date.parse(label.approvedAt)))) throw new Error('RETRIEVAL_APPROVAL_DATE_INVALID');
    if (label.approvedAt !== null && (!label.reviewer || !label.languageGroup)) throw new Error('RETRIEVAL_APPROVAL_METADATA_MISSING');
    if (splits.has(label.groupId) && splits.get(label.groupId) !== label.split) throw new Error('RETRIEVAL_SPLIT_LEAKAGE');
    splits.set(label.groupId, label.split); byId.set(label.caseId, label);
  }
  const observations = new Map();
  const runsByCase = new Map();
  for (const row of input.observations) {
    if (!byId.has(row.caseId)) throw new Error('RETRIEVAL_UNKNOWN_CASE');
    const id = JSON.stringify([row.caseId, row.runId, row.mode]);
    if (observations.has(id)) throw new Error('RETRIEVAL_DUPLICATE_OBSERVATION');
    if (row.rankedIds.some(value => !row.candidateIds.includes(value))) throw new Error('RETRIEVAL_RANK_OUTSIDE_CANDIDATES');
    observations.set(id, row);
    if (!runsByCase.has(row.caseId)) runsByCase.set(row.caseId, new Set());
    runsByCase.get(row.caseId).add(row.runId);
  }
  const reports = blocks.map(block => {
    const approved = input.labels.filter(label => label.block === block && label.approvedAt !== null && label.split === 'holdout');
    const reasons = [];
    if (approved.length < input.policy.minLabelsPerBlock) reasons.push('INSUFFICIENT_APPROVED_HOLDOUT_LABELS');
    const missingGroups = groups.filter(group => !approved.some(label => label.languageGroup === group));
    if (missingGroups.length) reasons.push('LANGUAGE_GROUPS_MISSING');
    const details = [];
    let pairedCases = 0;
    for (const label of approved) {
      const runs = [...(runsByCase.get(label.caseId) || [])];
      if (!runs.length) reasons.push('OBSERVATIONS_MISSING');
      let paired = false;
      for (const runId of runs) {
        const pair = ['on', 'off'].map(mode => observations.get(JSON.stringify([label.caseId, runId, mode])));
        if (pair.some(row => !row)) { reasons.push('ON_OFF_PAIR_MISSING'); continue; }
        paired = true;
        for (const row of pair) {
          const failures = [];
          if (Object.values(row.safety).some(value => value !== 'passed')) failures.push('SAFETY_NOT_PASSED');
          if (row.mode === 'off' && (row.embeddingCalls || row.qdrantCalls)) failures.push('OFF_VECTOR_CALL_DETECTED');
          if (row.errorCode) failures.push('RETRIEVAL_EXECUTION_ERROR');
          reasons.push(...failures);
          const expected = label.expectedIds;
          const recall = returned => expected.length ? expected.filter(id => returned.includes(id)).length / expected.length : null;
          details.push({ caseId: label.caseId, runId, groupId: label.groupId, languageGroup: label.languageGroup, mode: row.mode,
            candidateRecall: recall(row.candidateIds), recallAtK: recall(row.rankedIds.slice(0, input.policy.k)),
            dispositionCorrect: row.disposition === label.expectedDisposition, latencyMs: row.latencyMs, tokens: row.tokens ?? null, failures });
        }
      }
      if (paired) pairedCases++;
    }
    const summarize = rows => ({ observations: rows.length, candidateRecall: mean(rows.map(row => row.candidateRecall).filter(value => value !== null)),
      recallAtK: mean(rows.map(row => row.recallAtK).filter(value => value !== null)),
      dispositionAccuracy: mean(rows.map(row => Number(row.dispositionCorrect))),
      p50Ms: percentile(rows.map(row => row.latencyMs), 0.5), p95Ms: percentile(rows.map(row => row.latencyMs), 0.95),
      meanTokens: rows.every(row => row.tokens !== null) ? mean(rows.map(row => row.tokens)) : null });
    const on = summarize(details.filter(row => row.mode === 'on'));
    const off = summarize(details.filter(row => row.mode === 'off'));
    const detailIndex = new Map(details.map(row => [JSON.stringify([row.caseId, row.runId, row.mode]), row]));
    // Independent conversation groups, not repeated model calls, form sampling units.
    // A conservative bounded-mean interval avoids claiming certainty from a small sample.
    const differences = metric => {
      const clusters = new Map();
      for (const row of details.filter(row => row.mode === 'on')) {
        const other = detailIndex.get(JSON.stringify([row.caseId, row.runId, 'off']));
        const a = metric(row), b = metric(other);
        if (a === null || b === null) continue;
        if (!clusters.has(row.groupId)) clusters.set(row.groupId, []);
        clusters.get(row.groupId).push(b - a);
      }
      const values = [...clusters.values()].map(mean);
      const delta = mean(values);
      const radius = values.length ? Math.sqrt(2 * Math.log(2 / input.policy.alpha) / values.length) : null;
      return { independentGroups: values.length, offMinusOn: delta,
        lower: delta === null ? null : Math.max(-1, delta - radius), upper: delta === null ? null : Math.min(1, delta + radius) };
    };
    const intervals = { candidateRecall: differences(row => row.candidateRecall), recallAtK: differences(row => row.recallAtK),
      dispositionAccuracy: differences(row => Number(row.dispositionCorrect)) };
    const uniqueReasons = [...new Set(reasons)];
    const nonInferior = Object.values(intervals).every(interval => interval.lower !== null && interval.lower >= -input.policy.margin);
    return { block, approvedHoldoutLabels: approved.length, pairedCases, missingGroups, reasons: uniqueReasons,
      status: uniqueReasons.length ? 'not_ready' : nonInferior ? 'retrieval_non_inferior' : 'inconclusive',
      on, off, intervals, byLanguageGroup: Object.fromEntries(groups.map(group => [group, {
        on: summarize(details.filter(row => row.languageGroup === group && row.mode === 'on')),
        off: summarize(details.filter(row => row.languageGroup === group && row.mode === 'off'))
      }])), details };
  });
  return { reportVersion: '1', kind: 'paired_retrieval_measurement', snapshot: input.snapshot, policy: input.policy,
    blocks: reports, defaultConfigurationDecision: 'unchanged_pending_end_to_end_evidence_and_owner_decision',
    intervalMethod: 'Conservative bounded-mean interval on independent conversation-group differences; independence is an assumption. alpha is per metric, not a simultaneous guarantee.',
    limitations: ['Observations and safety assessments are supplied evidence; this scorer does not execute retrieval or verify ACLs.',
      'Retrieval measurements do not establish end-to-end answer quality.', 'No default configuration is changed.'] };
}
module.exports = { evaluate, schema };
