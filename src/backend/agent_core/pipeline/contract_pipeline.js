'use strict';

// Contract-first data pipeline (HARNESS_PIPELINE=v2):
//   schema retrieval (no model) -> ONE model call for a query contract ->
//   compile against verified metadata -> execute -> deterministic answer.
// The model never writes SQL here. Questions it cannot express (chat,
// documents, unsupported shapes) return { fallback } to the agent loop.
const Ajv = require('ajv');
const catalogApi = require('./query_catalog');
const { compile } = require('./query_compiler');
const { normalizeAssistantResponse } = require('../harness/tool_call_normalizer');

const ref = { type: 'string', minLength: 1, maxLength: 200 };
const contractSchema = { type: 'object', additionalProperties: false, required: ['kind'], properties: {
  kind: { enum: ['data', 'workflow', 'resume', 'previous', 'document', 'chat', 'clarify'] },
  previous: { type: 'object', additionalProperties: false, required: ['turn', 'rows'], properties: {
    turn: { type: 'integer', minimum: 1, maximum: 10 }, rows: { type: 'array', maxItems: 20, items: { type: 'integer', minimum: 1, maximum: 20 } },
    columns: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 120 } } } },
  workflow: { type: 'object', additionalProperties: false, properties: {
    templateId: { type: 'string', maxLength: 200 },
    inputs: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    evidence: { type: 'object', additionalProperties: { type: 'string', maxLength: 200 } } } },
  output: { type: 'object', additionalProperties: false, properties: {
    chart: { enum: ['none', 'bar', 'line', 'pie'] }, export: { enum: ['none', 'xlsx', 'csv', 'pdf'] }, splitBy: ref } },
  clarification: { type: 'string', maxLength: 300 },
  followup: { type: 'boolean' },
  root: { type: 'string', maxLength: 128 },
  operation: { enum: ['list', 'aggregate'] },
  fields: { type: 'array', maxItems: 20, items: ref },
  measures: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['ref', 'aggregation'], properties: {
    ref, aggregation: { enum: ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'] }, distinct: { type: 'boolean' }, label: { type: 'string', maxLength: 80 } } } },
  groupBy: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['ref'], properties: {
    ref, grain: { enum: ['day', 'month', 'year'] } } } },
  filters: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['ref', 'operator', 'evidence'], properties: {
    ref, operator: { enum: ['eq', 'in', 'ne', 'notIn', 'contains', 'period', 'gte', 'gt', 'lt', 'lte', 'isNull', 'notNull'] },
    value: { type: ['string', 'number', 'boolean'] }, values: { type: 'array', maxItems: 50, items: { type: ['string', 'number'] } },
    evidence: { type: 'string', maxLength: 200 }, inherited: { type: 'boolean' }, fromResult: { type: 'boolean' } } } },
  sort: { type: 'object', additionalProperties: false, required: ['by'], properties: { by: { type: 'string', maxLength: 200 }, direction: { enum: ['ASC', 'DESC'] } } },
  limit: { type: 'integer', minimum: 1, maximum: 1000 },
  ignoredTerms: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 100 } },
  analysis: { enum: ['none', 'anomaly'] }
} };
const validate = new Ajv({ strict: false }).compile(contractSchema);
const definition = { type: 'function', function: { name: 'plan_query',
  description: 'Return the query contract for the current question over the supplied catalog.', parameters: contractSchema } };

const RULES = `You translate the user's business question into a query contract over CATALOG. Call plan_query only; never write SQL or answer.
- kind=document for questions answered by company documents (user guides, policies, plans, procedures) rather than database records.
- kind=data for questions answered by catalog records; kind=chat for greetings, explanations, documents or anything not in the catalog; kind=clarify only when a required value is truly ambiguous (Vietnamese question in clarification).
- root: the table whose rows are listed, counted or summed (the table holding the measure).
- Reference columns as "Table.Column". To use a lookup (code, name, status, period name, group) go through the foreign key: "Root.FKColumn->LookupColumn", e.g. "Orders.StatusID->StatusName", "Orders.CustomerID->CustomerCode". Never compare a code or name with a numeric ID column.
- operation=list returns records: choose the fields the question implies (for transactions include the business date and the main amount; for people include code and name); empty fields = the table's default list. "theo X" / "by X" means groupBy X. operation=aggregate returns measures, optionally grouped (groupBy). Foreign keys in fields/groupBy are shown by their display column automatically.
- Measures use root columns only; COUNT of records uses ref "*". Rankings ("cao nhất", "top 5") use sort {by:"measure:0"} and limit.
- Exclusions ("trừ", "ngoại trừ", "không phải", "không bao gồm") use operator ne (one value) or notIn (values).
- If a word of the question looks like a code or a stored value but is not a criterion (e.g. part of a name), list it in ignoredTerms.
- Every code, date, period or year written in the question must appear in a filter; never drop one. Named values (a department, status, group, type or period name such as "phòng Kỹ thuật", "đang xử lý") are filters too.
- If the right table is only in OTHER TABLES, use it anyway (as root or in refs); its columns are supplied on the next turn.
- Prefer columns with a business label (in quotes) over unlabeled columns of similar meaning, and the table whose entity matches the subject of the question.
- Every filter needs evidence: an exact quote from the question that contains the value. Dates: operator=period with value "YYYY", "YYYY-MM" or "YYYY-MM-DD" on the business date column; ranges use gte/lt with ISO dates. Relative periods are computed from TODAY. A named period such as "Kỳ 3" or "Q1" is a value in a lookup table reached through its foreign key, not a date.
- Unusual/abnormal months: operation=aggregate grouped by the business date with grain=month, analysis=anomaly.
- kind=workflow when one of WORKFLOWS is built for the requested lookup or report (same entity, measure, time semantics and outputs): prefer it over kind=data even if the catalog could also answer, because the business configured it. Set workflow.templateId, and in workflow.inputs only values stated in the question, each with its exact quote in workflow.evidence (missing inputs are asked later). A broader report, a different entity or a filter the workflow cannot apply means kind=data.
- PENDING lists a workflow waiting for inputs. Use kind=resume only when the current message answers one or more of those inputs: put them in workflow.inputs with exact quotes in workflow.evidence. A new or different request is not a resume.
- One file per group ("mỗi phòng ban một file", "tách file theo X"): operation=list, output.export and output.splitBy = the grouping ref (e.g. "Root.FKColumn").
- output.chart (bar/line/pie) when a chart is asked ("biểu đồ", "vẽ"); it needs operation=aggregate with groupBy. output.export (xlsx/csv/pdf) when a file is asked ("xuất file", "excel"). Otherwise omit output.
- When the answer is already in rows shown in PREVIOUS (e.g. "người thứ 2 trong danh sách trên tên gì"), use kind=previous with previous.turn (1 = oldest in PREVIOUS), previous.rows (row numbers shown) and previous.columns (column names to show, empty = all). Do not use it for new measures, totals or rows that were not shown.
- Otherwise rows of a previous result ("người thứ 2", "khách hàng đó", "hóa đơn lớn nhất ở trên"): read them in PREVIOUS turns' result rows (numbered from 1), filter by that row's identity value (code/name/ID) with fromResult=true and evidence = the referring words of the question.
- A PREVIOUS turn with "workflow" holds a completed workflow result. To chart or export that result, use kind=previous with previous.turn, previous.rows=[] and output.chart or output.export. A question about its values (highest month, a row) is kind=chat answered from its rows; a new filter or period is kind=workflow or kind=data.
- A question may return to an older turn in PREVIOUS (not only the last one): start from that turn's contract.
- Follow-up (PREVIOUS is given and the question continues it, e.g. "còn tháng 1 thì sao", "vậy tìm trong năm 2024", "thêm cột giới tính"): set followup=true, start from PREVIOUS.contract and change only what the user changed. Carried filters keep their evidence from the previous question and set inherited=true. "tất cả/toàn bộ" removes the carried filter.`;

function decode(response) {
  let value = normalizeAssistantResponse(response).calls?.find(call => call.name === 'plan_query')?.arguments;
  if (!value) { try { value = JSON.parse(String(response.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid below */ } }
  // A contract that omits kind but is otherwise explicit is not ambiguous.
  if (value && typeof value === 'object' && !value.kind) value.kind = value.workflow ? 'workflow' : value.root ? 'data' : value.kind;
  if (!validate(value)) throw Object.assign(new Error('V2_CONTRACT_INVALID'), { code: 'V2_CONTRACT_INVALID',
    details: (validate.errors || []).slice(0, 5).map(error => `${error.instancePath} ${error.message}`) });
  return value;
}

// Authorized tables retrieval did not select: names and entities only.
function otherTables(selection, catalog) {
  return (selection.tableDirectory || []).filter(item => !catalogApi.table(catalog, item.tableName))
    .map(item => `${item.tableName}${item.entity ? ` (${item.entity})` : ''}`).join('; ') || 'none';
}

// Independent coverage check: every explicit code, date or year in the
// question must reach a filter (or the row limit). A contract that silently
// widens "<code> tháng 2024-02" to all records or all months is rejected.
function uncovered(contract, question) {
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const tokens = [...new Set([
    ...(question.match(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}\/\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || []),
    ...(question.replace(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{1,2}\/\d{4}\b/g, ' ').match(/\b(?:19|20)\d{2}\b/g) || []),
    ...(question.match(/\b[A-Za-z][A-Za-z_-]*\d[A-Za-z0-9_-]*\b/g) || [])
  ])];
  const covered = [...(contract.filters || []).map(filter => fold([filter.evidence, filter.value, ...(filter.values || [])].join(' '))),
    ...(contract.ignoredTerms || []).map(fold)];
  return tokens.filter(token => !covered.some(text => text.includes(fold(token))) && String(contract.limit) !== token);
}

// Relationship roles named in the question shape the output: a list that asks
// "những khách hàng nào" shows the customer; "theo trạng thái" groups by status.
function applyRoles(contract, question, catalog) {
  const root = catalogApi.table(catalog, contract.root);
  if (!root) return [];
  const { mentions } = require('./coverage');
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
  const text = fold(question);
  const usesKey = (refs, fk) => refs.some(ref => {
    const head = String(ref).split('->')[0];
    return catalogApi.key(head.includes('.') ? head.split('.').pop() : head) === catalogApi.key(fk);
  });
  const added = [];
  for (const relation of catalog.relations.filter(item => catalogApi.key(item.fromTable) === catalogApi.key(root.tableName) && item.role && item.display)) {
    const fk = relation.pairs[0].source, role = fold(relation.role), ref = `${root.tableName}.${fk}`;
    if (contract.operation === 'aggregate' && mentions(text, `theo ${role}`) && !usesKey((contract.groupBy || []).map(item => item.ref), fk)) {
      contract.groupBy = [...(contract.groupBy || []), { ref }]; added.push(`groupBy:${ref}`);
    }
    if (contract.operation === 'list' && contract.fields?.length && mentions(text, role) && !usesKey(contract.fields, fk)) {
      contract.fields = [...contract.fields, ref]; added.push(`field:${ref}`);
    }
    if (contract.operation === 'list' && !contract.fields?.length && mentions(text, role)) {
      contract.fields = [...root.defaults.map(name => `${root.tableName}.${name}`), ref]; added.push(`field:${ref}`);
    }
  }
  return added;
}

// A follow-up contract only states what changed. What it leaves out (root,
// operation, measures/fields, grouping, analysis) comes from the previous
// contract, and a filter repeating a previous one with a value the current
// question does not contain is the carried filter, so it is marked inherited.
function completeFollowup(contract, previous, question) {
  const before = previous?.contract;
  if (!before?.root || (!contract.followup && contract.root)) return [];
  const filled = [];
  for (const key of ['root', 'operation', 'analysis']) if (!contract[key] && before[key]) { contract[key] = before[key]; filled.push(key); }
  if (catalogApi.key(contract.root) === catalogApi.key(before.root)) {
    if (contract.operation === 'aggregate' && !contract.measures?.length && before.measures?.length) { contract.measures = structuredClone(before.measures); filled.push('measures'); }
    if (contract.operation === 'aggregate' && !contract.groupBy && before.groupBy?.length) { contract.groupBy = structuredClone(before.groupBy); filled.push('groupBy'); }
    if (contract.operation === 'list' && !contract.fields?.length && before.fields?.length) { contract.fields = [...before.fields]; filled.push('fields'); }
  }
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  for (const filter of contract.filters || []) {
    const same = (before.filters || []).find(item => item.ref === filter.ref && String(item.value) === String(filter.value));
    if (same && !filter.inherited && !fold(question).includes(fold(filter.value))) { filter.inherited = true; filled.push(`inherited:${filter.ref}`); }
  }
  if (filled.length) contract.followup = true;
  return filled;
}

// A follow-up keeps the previous measure unless the question names the
// difference: "còn tháng 1 thì sao" must not silently switch from the
// after-tax to the pre-tax amount. Words that distinguish the new measure's
// label from the old one ("trước" vs "sau") must appear in the question.
function keepMeasures(contract, previous, question, catalog) {
  const before = previous?.contract;
  if (!contract.followup || contract.operation !== 'aggregate' || before?.operation !== 'aggregate'
    || catalogApi.key(before.root) !== catalogApi.key(contract.root) || !before.measures?.length || !contract.measures?.length) return null;
  const signature = measures => measures.map(item => `${item.aggregation}:${catalogApi.key(String(item.ref).split('.').pop())}`).join('|');
  if (signature(before.measures) === signature(contract.measures)) return null;
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const words = measures => new Set(measures.flatMap(item => {
    const name = String(item.ref).split('->').pop().split('.').pop();
    const column = catalogApi.column(catalog, contract.root, name);
    return fold(`${column?.label || ''} ${name} ${item.label || ''}`).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 1);
  }));
  const previousWords = words(before.measures);
  const distinguishing = [...words(contract.measures)].filter(word => !previousWords.has(word));
  const asked = fold(question);
  if (distinguishing.some(word => asked.includes(word))) return null;
  const replaced = contract.measures;
  contract.measures = structuredClone(before.measures);
  return { from: replaced.map(item => item.ref), to: contract.measures.map(item => item.ref) };
}

// Safety net for follow-ups: an equality filter of the previous contract that
// the model forgot is carried unless the user widened the scope.
function carryFilters(contract, previous, question) {
  if (!contract.followup || !previous?.contract?.filters?.length) return [];
  // \b treats Vietnamese letters as non-word characters; match on spacing instead.
  if (/(^|[\s,.;:!?])(tất cả|toàn bộ|mọi|all)(?=$|[\s,.;:!?])/iu.test(question)) return [];
  const target = item => item.ref.split('->')[0].split('.')[0].toLowerCase();
  const columnOf = item => item.ref.toLowerCase();
  const added = previous.contract.filters.filter(item => ['eq', 'in'].includes(item.operator)
    && !(contract.filters || []).some(current => columnOf(current) === columnOf(item) || (target(current) === target(item) && current.ref.split('->').length > 1)))
    .map(item => ({ ...item, inherited: true }));
  contract.filters = [...(contract.filters || []), ...added];
  return added;
}

async function run({ question, plan, context, toolContext, dispatch, toolManager, trace, toolCalls, requestTime, conversation = [], pendingInput = null }) {
  const step = (type, data = {}) => trace.steps.push({ type, ...data });
  // 1. Schema retrieval is deterministic tool code, not a model round.
  const searchArgs = { query: question, request: { operation: 'list', attributes: [], presentation: 'unspecified' } };
  const search = await toolManager.executeTool('search_schema', searchArgs, { ...toolContext, governedController: true });
  toolCalls.push({ toolName: 'search_schema', args: searchArgs, success: search.success, result: search.result || null, error: search.error || null });
  if (!search.success || search.result?.mode !== 'data') return conversationReply({ question, conversation, dispatch, plan, context, toolContext, previousTurns: [] });
  // A follow-up ("còn khách hàng X thì sao?") names no table: keep the
  // tables of the previous contract available alongside the new retrieval.
  const sameSource = item => !item?.dbSourceId || item.dbSourceId === search.result.dbSourceId;
  const turns = (context.resolutionContext?.turns || []).filter(sameSource).slice(-3);
  const stored = context.resolutionContext?.previousRequest?.businessState?.v2 || null;
  const lastContractTurn = [...turns].reverse().find(turn => turn.contract?.root);
  const previous = lastContractTurn ? { contract: lastContractTurn.contract, question: lastContractTurn.question }
    : stored && sameSource(stored) ? stored : null;
  // Carried evidence may come from any recent question (returning to an older topic).
  const previousQuestions = [...turns.map(turn => turn.question), previous?.question].filter(Boolean).join('\n');
  // Values a row reference may resolve to: cells of the results the user saw.
  const resultValues = new Set(turns.flatMap(turn => turn.result?.preview || []).flat()
    .filter(value => value !== null && value !== '').map(value => String(value).normalize('NFC').toLocaleLowerCase('vi').trim()));
  const previousTables = [...new Set([...turns.map(turn => turn.contract), previous?.contract].filter(Boolean)
    .flatMap(contract => [contract.root, ...(JSON.stringify(contract).match(/[A-Za-z_][A-Za-z0-9_]*(?=\.[A-Za-z_])/g) || [])]))];
  let catalog = catalogApi.build(search.result, { include: previousTables });
  if (!catalog.tables.size) return { fallback: 'V2_SCHEMA_EMPTY' };

  // Authorized workflows are offered in the same contract call (tool code, no model).
  let workflows = [];
  if (['list_workflows', 'run_workflow'].every(name => toolContext.allowedToolNames?.includes(name))) {
    const listed = await toolManager.executeTool('list_workflows', { limit: 30 }, toolContext);
    if (listed.success) workflows = listed.result?.workflows || [];
  }

  // 2. One structured model call (plus at most one targeted repair).
  const recent = turns.length ? [] : (context.resolutionContext?.recent || []).slice(-4).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 600) }));
  const previousTurns = turns.map(turn => ({ question: turn.question, status: turn.status, contract: turn.contract || undefined,
    workflow: turn.workflow?.name || undefined,
    answer: turn.contract ? undefined : String(turn.reply || '').slice(0, 400),
    result: turn.result ? { columns: turn.result.columns, rowCount: turn.result.rowCount,
      rows: turn.result.preview.slice(0, 10).map((row, index) => [index + 1, ...row]) } : undefined }));
  const messages = [{ role: 'system', content: RULES },
    { role: 'user', content: `TODAY: ${requestTime.today}\nCATALOG:\n${catalogApi.describe(catalog)}\n`
      + `OTHER TABLES (columns supplied on request): ${otherTables(search.result, catalog)}\n`
      + (workflows.length ? `WORKFLOWS: ${describeWorkflows(workflows)}\n` : '')
      + (pendingInput ? `PENDING: ${JSON.stringify({ workflow: pendingInput.name, missingInputs: Object.entries(pendingInput.inputs || {})
        .map(([key, slot]) => ({ key, label: slot.label || key, ask: slot.ask, type: slot.schema?.type || 'string' })) })}\n` : '')
      + (previousTurns.length ? `PREVIOUS (oldest first): ${JSON.stringify(previousTurns)}\n` : previous ? `PREVIOUS: ${JSON.stringify([previous])}\n` : '')
      + (recent.length ? `RECENT: ${JSON.stringify(recent)}\n` : '')
      + `QUESTION: ${question}` }];
  // Lookup values for the coverage check run through the governed SQL tool.
  const lookupRows = async query => {
    const result = await toolManager.executeTool('execute_sql_query', { sql: query.sql }, { ...toolContext, joinPlan: query.joinPlan, compiledSemanticQuery: false });
    return result.success ? result.result?.rows || [] : null;
  };
  let contract, compiled, lastError, attempts = 2;
  for (let attempt = 0; attempt < attempts && !compiled; attempt++) {
    const response = await dispatch([definition], messages, attempt ? 'v2_contract_repair' : 'v2_contract');
    try {
      contract = decode(response);
      step('V2_CONTRACT', { attempt, contract: structuredClone(contract) });
      if (contract.kind === 'chat') return { ...(await conversationReply({ question, conversation, dispatch, plan, context, toolContext, previousTurns, step })), contract };
      if (contract.kind === 'document') {
        if (!toolContext.allowedToolNames?.includes('search_knowledge_base')) return { ...(await conversationReply({ question, conversation, dispatch, plan, context, toolContext, previousTurns, step })), contract };
        return { ...(await require('./conversation_answer').searchDocuments({ question, conversation, dispatch, plan, context, toolManager, toolContext, toolCalls, step })), contract };
      }
      // Inputs without their quote would be dropped and asked again: ask the model for the quotes instead.
      const unquoted = ['workflow', 'resume'].includes(contract.kind) ? Object.keys(contract.workflow?.inputs || {})
        .filter(name => typeof contract.workflow?.evidence?.[name] !== 'string' || !contract.workflow.evidence[name].trim()) : [];
      if (unquoted.length) throw Object.assign(new Error(`V2_WORKFLOW_EVIDENCE_MISSING: set workflow.evidence.<input> to the exact words of the question for ${unquoted.join(', ')}`), { code: 'V2_WORKFLOW_EVIDENCE_MISSING' });
      if (contract.kind === 'resume') {
        if (!pendingInput) throw Object.assign(new Error('V2_RESUME_UNAVAILABLE: no workflow is waiting for input; answer with another kind'), { code: 'V2_RESUME_UNAVAILABLE' });
        const inputs = slotInputs(contract.workflow, pendingInput.inputs, question);
        if (!Object.keys(inputs).length) return { contract, status: 'CLARIFY', reply: `Để tiếp tục quy trình **${pendingInput.name}**, mình cần thêm:\n`
          + Object.entries(pendingInput.inputs || {}).map(([key, slot]) => `- ${slot.ask || slot.label || key}`).join('\n') };
        const args = { runId: pendingInput.runId, revision: pendingInput.revision, inputs };
        const execution = await toolManager.executeTool('resume_workflow', args, toolContext);
        step('V2_WORKFLOW_RESUMED', { runId: pendingInput.runId, inputs: Object.keys(inputs), success: execution.success, code: execution.code || null });
        if (execution.success && execution.result?.execution) {
          toolCalls.push({ toolName: 'resume_workflow', args, success: true, result: execution.result, error: null });
          return { contract, handoff: execution.result.execution };
        }
        throw Object.assign(new Error(`V2_RESUME_FAILED: ${String(execution.error || execution.code).slice(0, 200)}`), { code: 'V2_RESUME_FAILED' });
      }
      if (contract.kind === 'clarify') return { contract, reply: contract.clarification || 'Bạn có thể nói rõ hơn phạm vi dữ liệu cần tra cứu không?', status: 'CLARIFY' };
      if (contract.kind === 'previous') {
        const turn = turns[contract.previous?.turn - 1];
        if (turn?.workflow && (exportFormat(contract, plan) || ['bar', 'line', 'pie'].includes(contract.output?.chart)))
          return { contract, ...(await workflowOutput(turn, contract, plan, toolManager, toolContext, toolCalls, step)) };
        const answer = previousRows(contract.previous, turns);
        if (answer) { step('V2_PREVIOUS_ROWS', { turn: contract.previous.turn, rows: contract.previous.rows }); return { contract, reply: answer, status: 'SUCCESS' }; }
        throw Object.assign(new Error('V2_PREVIOUS_UNAVAILABLE: those rows were not shown in PREVIOUS. Query them with kind=data and fromResult filters'), { code: 'V2_PREVIOUS_UNAVAILABLE' });
      }
      if (contract.kind === 'workflow') {
        if (contract.operation) plan.conversationState = { ...plan.conversationState, operation: contract.operation };
        const started = await runWorkflow(contract, workflows, question, toolManager, toolContext, step);
        if (started.handoff) { toolCalls.push(started.call); return { contract, handoff: started.handoff }; }
        // An unsuitable or failed workflow is not a dead end: ask once more for a data contract.
        workflows = workflows.filter(item => item.templateId !== contract.workflow?.templateId);
        if (attempts < 3) attempts++;
        throw Object.assign(new Error(`V2_WORKFLOW_REJECTED: ${String(started.reason).slice(0, 200)}. Answer with kind=data over CATALOG instead`), { code: 'V2_WORKFLOW_REJECTED' });
      }
      // A file needs every matching row, not the 100-row display page.
      if (exportFormat(contract, plan) && contract.operation !== 'aggregate' && !contract.limit) contract.exportLimit = true;
      const dropped = uncovered(contract, question);
      if (dropped.length) throw Object.assign(new Error(`V2_CRITERION_DROPPED: the question states ${dropped.map(item => `"${item}"`).join(', ')} but no filter uses it`), { code: 'V2_CRITERION_DROPPED' });
      const filled = completeFollowup(contract, previous, question);
      if (filled.length) step('V2_FOLLOWUP_COMPLETED', { fields: filled });
      const splitBy = contract.output?.splitBy;
      if (splitBy && contract.operation !== 'aggregate' && !(contract.fields || []).includes(splitBy)) {
        const rootEntry = catalogApi.table(catalog, contract.root);
        contract.fields = [...(contract.fields?.length ? contract.fields : (rootEntry?.defaults || []).map(name => `${rootEntry.tableName}.${name}`)), splitBy];
      }
      const roles = applyRoles(contract, question, catalog);
      if (roles.length) step('V2_ROLES_APPLIED', { refs: roles });
      if (contract.root && catalogApi.table(catalog, contract.root)) {
        const terms = await require('./coverage').lookupTerms(catalogApi.table(catalog, contract.root).tableName, catalog, lookupRows);
        const problems = require('./coverage').check(contract, question, terms);
        if (problems.length) throw Object.assign(new Error(`V2_CRITERION_DROPPED: ${problems.join('; ')}`), { code: 'V2_CRITERION_DROPPED' });
      }
      const kept = keepMeasures(contract, previous, question, catalog);
      if (kept) step('V2_MEASURES_KEPT', kept);
      const carried = carryFilters(contract, previous, question);
      if (carried.length) step('V2_FILTERS_CARRIED', { refs: carried.map(item => item.ref) });
      compiled = compile(contract.exportLimit ? { ...contract, limit: 1000 } : contract, catalog, { question, previousQuestion: previousQuestions, resultValues });
    } catch (error) {
      lastError = error;
      // Retrieval may miss the right table (a similar entity is selected). A
      // contract naming an authorized table outside the catalog loads its
      // metadata for the repair round instead of failing.
      const named = [...new Set([contract?.root, ...(JSON.stringify(contract || {}).match(/[A-Za-z_][A-Za-z0-9_]*(?=\.[A-Za-z_])/g) || [])]
        .filter(name => name && !catalogApi.table(catalog, name)))];
      if (['V2_ROOT_UNKNOWN', 'V2_TABLE_UNKNOWN'].includes(error.code) && named.length) {
        const before = new Set(catalog.tables.keys());
        catalog = catalogApi.build(search.result, { include: [...previousTables, ...catalog.tables.values()].map(item => item.tableName || item).concat(named) });
        const added = [...catalog.tables.values()].filter(item => !before.has(catalogApi.key(item.tableName)));
        if (added.length) {
          step('V2_CATALOG_EXTENDED', { tables: added.map(item => item.tableName) });
          // The model has not seen these columns yet: give it one more round.
          if (attempts < 3) attempts++;
          error.message += `\nAdditional catalog:\n${catalogApi.describe({ ...catalog, tables: new Map(added.map(item => [catalogApi.key(item.tableName), item])) })}`;
        }
      }
      step('V2_CONTRACT_REJECTED', { attempt, code: error.code || 'V2_CONTRACT_INVALID', detail: String(error.message).slice(0, 300), ...(error.details ? { details: error.details } : {}) });
      messages.push({ role: 'assistant', content: JSON.stringify(contract || {}) },
        { role: 'user', content: `The contract was rejected: ${String(error.message).slice(0, 400)}${error.details ? ` ${error.details.join('; ')}` : ''}. `
          + 'Fix only that problem using exact catalog names and quotes from the question, then call plan_query again.' });
    }
  }
  if (!compiled) return { fallback: lastError?.code || 'V2_CONTRACT_INVALID', contract };
  step('V2_COMPILED', { root: compiled.root, operation: compiled.operation, joins: compiled.joinPlan.edges.length, filters: compiled.requestFilters.length });

  // 3. Execute through the governed SQL tool (permissions, security guard, completeness).
  const execute = async query => {
    const args = { sql: query.sql };
    const execution = await toolManager.executeTool('execute_sql_query', args, { ...toolContext, joinPlan: query.joinPlan,
      compiledSemanticQuery: false, requestPlan: { ...plan, rowLimit: contract.limit || null } });
    const result = { toolName: 'execute_sql_query', args, success: execution.success, result: execution.result || null,
      error: execution.error || null, code: execution.code || null, outcome: execution.outcome, effectState: execution.effectState };
    toolCalls.push(result);
    if (!execution.success) step('V2_EXECUTION_FAILED', { code: execution.code || null });
    return result;
  };
  let call = await execute(compiled);
  if (!call.success) return { fallback: call.code || 'V2_EXECUTION_FAILED', contract };

  // 4. Nothing matched a text value ("Phòng Kỹ thuật" vs stored "Kỹ thuật"):
  // look the value up in its column once. One candidate is used and shown in
  // the scope; several candidates are asked back instead of guessed.
  if (noMatch(compiled, call.result.rows) && compiled.textFilters.length) {
    const resolved = await resolveValues(compiled.textFilters, contract, toolManager, toolContext, step);
    if (resolved.clarify) return { contract, reply: resolved.clarify, status: 'CLARIFY' };
    if (resolved.changes.length) {
      step('V2_VALUE_RESOLVED', { changes: resolved.changes });
      compiled = compile(contract.exportLimit ? { ...contract, limit: 1000 } : contract, catalog, { question, previousQuestion: previousQuestions, resultValues });
      call = await execute(compiled);
      if (!call.success) return { fallback: call.code || 'V2_EXECUTION_FAILED', contract };
    }
  }

  // 5. Deterministic answer from the verified rows, then requested outputs
  // built from the same rows (a chart or file can never drift from the data).
  let reply = render(compiled, call, question), status = 'SUCCESS';
  const rows = call.result.rows || [];
  const chartType = contract.output?.chart && contract.output.chart !== 'none' ? contract.output.chart : plan.outputs?.chart ? 'auto' : null;
  if (chartType) {
    const args = chartArgs(compiled, rows, chartType, question);
    if (!args) { reply += '\n\nChưa vẽ được biểu đồ: kết quả cần ít nhất một chiều phân nhóm và một số liệu.'; status = 'PARTIAL'; }
    else {
      const chart = await toolManager.executeTool('render_chart', args, toolContext);
      toolCalls.push({ toolName: 'render_chart', args, success: chart.success, result: chart.result || null, error: chart.error || null });
      if (!chart.success) { reply += '\n\nĐã lấy được số liệu, nhưng chưa tạo được biểu đồ.'; status = 'PARTIAL'; }
    }
  }
  const format = exportFormat(contract, plan);
  const split = contract.output?.splitBy && compiled.outputs.find(item => item.ref === contract.output.splitBy);
  if (plan.exportRequest?.separate && !split) { reply += '\n\nChưa xác định được cột để tách file theo nhóm; hãy nói rõ tách theo cột nào.'; status = 'PARTIAL'; }
  else if (format && rows.length && split) {
    const exported = await exportGroups(rows, split.alias, format, toolManager, toolContext, toolCalls);
    reply = `${reply}\n\n${exported.lines.join('\n')}`;
    const expected = plan.exportRequest?.expectedFiles;
    if (exported.failed || exported.tooMany || (expected && expected !== exported.count)) {
      reply += exported.tooMany ? '\n\nCó quá nhiều nhóm (tối đa 30 file); hãy thu hẹp phạm vi.'
        : expected && expected !== exported.count ? `\n\nYêu cầu ${expected} file nhưng dữ liệu có ${exported.count} nhóm.` : '\n\nMột số file chưa tạo được.';
      status = 'PARTIAL';
    }
  } else if (format && rows.length) {
    const args = { data: rows, format, filename: `Bao_cao_${new Date().toISOString().slice(0, 10)}` };
    const file = await toolManager.executeTool('export_data', args, { ...toolContext, verifiedExport: { resultGroupBy: [], displayNames: {} } });
    toolCalls.push({ toolName: 'export_data', args, success: file.success, result: file.result || null, error: file.error || null });
    if (file.success && file.result?.downloadUrl) reply = require('../harness/grounded_reply').ensureDownloadLink(reply, file.result.downloadUrl);
    else { reply += '\n\nChưa tạo được file xuất.'; status = 'PARTIAL'; }
  }
  return { contract, compiled, call, reply, status, dbSourceId: catalog.dbSourceId };
}

// Answer from rows the user already saw, copied from the turn log (no model-written values).
function previousRows(reference, turns) {
  const turn = turns[reference?.turn - 1];
  const result = turn?.result;
  if (!result?.preview?.length) return null;
  const rows = [...new Set(reference.rows)].map(number => result.preview[number - 1]);
  if (rows.some(row => !row)) return null;
  const wanted = (reference.columns || []).filter(name => result.columns.includes(name));
  const indexes = (wanted.length ? wanted : result.columns).map(name => result.columns.indexOf(name));
  const cell = value => value === null || value === undefined || value === '' ? '—' : typeof value === 'number' ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value) : String(value);
  const lines = rows.map((row, i) => `- **Dòng ${[...new Set(reference.rows)][i]}:** ${indexes.map(index => `${result.columns[index]}: ${cell(row[index])}`).join('; ')}`);
  return `Theo kết quả của câu “${String(turn.question).slice(0, 160)}”:\n\n${lines.join('\n')}`;
}

// Chart or file of a completed workflow result: the tools read the verified
// dataset by run id, so no rows pass through the model.
async function workflowOutput(turn, contract, plan, toolManager, toolContext, toolCalls, step) {
  const { runId, field, name } = turn.workflow;
  const context = { ...toolContext, workflowRunId: runId, memoryDecision: { reference: { data: { runId, field } } } };
  const call = async (toolName, args) => {
    const result = await toolManager.executeTool(toolName, args, context);
    toolCalls.push({ toolName, args, success: result.success, result: result.result || null, error: result.error || null });
    return result;
  };
  const lines = [], failed = [];
  const format = exportFormat(contract, plan);
  if (format) {
    const slug = String(name || 'Ket_qua').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60);
    const file = await call('export_data', { workflowRunId: runId, ...(field ? { workflowField: field } : {}), format, filename: slug });
    if (file.success && file.result?.downloadUrl) lines.push(`Tải file: [${file.result.filename || slug}](${file.result.downloadUrl})`);
    else failed.push('xuất file');
  }
  const requested = contract.output?.chart;
  if (['bar', 'line', 'pie'].includes(requested)) {
    const dataset = await call('get_workflow_dataset', { runId, ...(field ? { field } : {}), limit: 100 });
    const args = dataset.success ? datasetChart(dataset.result.rows || [], requested, name) : null;
    const chart = args ? await call('render_chart', args) : null;
    if (chart?.success) lines.push('Biểu đồ đã được tạo từ toàn bộ kết quả nghiệp vụ.');
    else failed.push('vẽ biểu đồ');
  }
  step('V2_WORKFLOW_OUTPUT', { runId, export: format || null, chart: requested || null, failed });
  const head = `Từ kết quả nghiệp vụ **${name}**:`;
  return { reply: [head, ...lines, ...(failed.length ? [`Chưa thể ${failed.join(' và ')} từ kết quả này.`] : [])].join('\n\n'),
    status: failed.length ? 'PARTIAL' : 'SUCCESS' };
}

// Labels from the first text column, one series per numeric column (IDs excluded).
function datasetChart(rows, type, title) {
  if (!rows.length) return null;
  const columns = Object.keys(rows[0]);
  const numeric = column => rows.every(row => row[column] === null || row[column] === '' || Number.isFinite(Number(row[column])));
  const label = columns.find(column => !numeric(column)) || columns[0];
  const series = columns.filter(column => column !== label && numeric(column) && !/(^|_)id$|id$/i.test(column)).slice(0, 4);
  if (!series.length) return null;
  const text = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '—');
  return { type, title: String(title || 'Kết quả nghiệp vụ').slice(0, 120), labels: rows.map(row => text(row[label])),
    datasets: series.map(column => ({ label: column, data: rows.map(row => Number(row[column]) || 0) })) };
}

// One file per value of the split column, each written from its own rows.
async function exportGroups(rows, alias, format, toolManager, toolContext, toolCalls) {
  const groups = new Map();
  for (const row of rows) {
    const name = row[alias] === null || row[alias] === undefined || row[alias] === '' ? 'Không xác định' : String(row[alias]);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  if (groups.size > 30) return { lines: [], count: groups.size, tooMany: true };
  const lines = [];
  let failed = false;
  for (const [name, data] of groups) {
    const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'Nhom';
    const args = { data, format, filename: `Bao_cao_${slug}` };
    const file = await toolManager.executeTool('export_data', args, { ...toolContext, verifiedExport: { resultGroupBy: [], displayNames: {} } });
    toolCalls.push({ toolName: 'export_data', args, success: file.success, result: file.result || null, error: file.error || null, exportGroup: name });
    if (file.success && file.result?.downloadUrl) lines.push(`- [${name.replace(/[[\]]/g, '')}](${file.result.downloadUrl}) — ${data.length} bản ghi`);
    else failed = true;
  }
  return { lines, count: groups.size, failed };
}

// Workflow inputs kept only when quoted from the question and valid for the slot.
function slotInputs(choice = {}, slots = {}, question = '') {
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const { validateValue } = require('../../automation/contract');
  const inputs = {};
  for (const [name, raw] of Object.entries(choice.inputs || {})) {
    const slot = slots?.[name], quote = choice.evidence?.[name];
    if (!slot || typeof quote !== 'string' || !quote.trim() || !fold(question).includes(fold(quote))) continue;
    const type = slot.schema?.type;
    const value = ['integer', 'number'].includes(type) ? Number(raw) : type === 'boolean' ? raw === true || /^(true|1|có|co|yes)$/i.test(String(raw).trim()) : String(raw);
    if (!validateValue(value, slot.schema, name).length) inputs[name] = value;
  }
  return inputs;
}

// Conversation stays on v2 unless an external (MCP) tool may be needed.
async function conversationReply({ question, conversation, dispatch, plan, context, toolContext, previousTurns, step }) {
  if ((toolContext.allowedToolNames || []).some(name => name.startsWith('mcp_'))) return { fallback: 'V2_EXTERNAL_TOOLS' };
  return require('./conversation_answer').chat({ question, conversation, dispatch, plan, context, previousTurns, step });
}

function exportFormat(contract, plan) {
  const value = contract.output?.export;
  return value && value !== 'none' ? value : plan.exportRequest?.export ? 'xlsx' : null;
}

// Labels from the dimension(s), one series per measure, values taken as-is.
function chartArgs(compiled, rows, requested, title) {
  const dimensions = compiled.outputs.filter(item => item.kind === 'dimension');
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  if (!dimensions.length || !measures.length || !rows.length) return null;
  const text = value => value instanceof Date ? value.toISOString().slice(0, value.getUTCDate() === 1 ? 7 : 10) : String(value ?? '—');
  const timeSeries = ['Tháng', 'Ngày', 'Năm'].includes(dimensions[0].alias);
  return { type: requested === 'auto' ? (timeSeries ? 'line' : 'bar') : requested, title: String(title).slice(0, 120),
    labels: rows.map(row => dimensions.map(item => text(row[item.alias])).join(' – ')),
    datasets: measures.map(item => ({ label: item.alias, data: rows.map(row => Number(row[item.alias]) || 0) })) };
}

function describeWorkflows(workflows) {
  return workflows.map(item => `${item.templateId}: ${item.name}${item.description ? ` — ${String(item.description).slice(0, 160)}` : ''}`
    + ` [operations: ${(item.operations || []).join(', ') || 'none'}; inputs: ${Object.entries(item.inputs || {})
      .map(([key, slot]) => `${key}${slot.required ? '*' : ''}(${slot.label || key}, ${slot.schema?.type || 'string'})`).join(', ') || 'none'}]`).join(' | ');
}

// Inputs are kept only when quoted from the question and valid for the slot schema.
async function runWorkflow(contract, workflows, question, toolManager, toolContext, step) {
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const choice = contract.workflow || {};
  const item = workflows.find(workflow => workflow.templateId === choice.templateId);
  if (!item) return { reason: `workflow ${choice.templateId} is not in WORKFLOWS` };
  const args = { templateId: item.templateId, inputs: slotInputs(choice, item.inputs, question) };
  let execution = await toolManager.executeTool('run_workflow', args, toolContext);
  // A malformed suitability answer is a formatting error, not a rejection: assess once more.
  if (!execution.success && execution.code === 'WORKFLOW_ASSESSMENT_INVALID') {
    step('V2_WORKFLOW_ASSESSMENT_RETRY', { templateId: item.templateId });
    execution = await toolManager.executeTool('run_workflow', args, toolContext);
  }
  const state = execution.result?.execution;
  step('V2_WORKFLOW', { templateId: item.templateId, success: execution.success, code: execution.code || null, status: state?.status || null,
    kept: Object.keys(args.inputs), dropped: Object.keys(choice.inputs || {}).filter(name => !(name in args.inputs)), slots: Object.keys(item.inputs || {}) });
  if (!execution.success) return { reason: execution.error || execution.code || 'workflow rejected' };
  if (!state || state.status === 'FAILED') return { reason: `workflow failed${state?.error?.message ? `: ${state.error.message}` : ''}` };
  return { handoff: state, call: { toolName: 'run_workflow', args, success: true, result: execution.result, error: null } };
}

// Empty rows, or one aggregate row whose measures are all NULL/0.
function noMatch(compiled, rows = []) {
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  return !rows.length || (compiled.operation === 'aggregate' && !compiled.outputs.some(item => item.kind === 'dimension')
    && rows.length === 1 && measures.every(item => [null, undefined, 0].includes(rows[0][item.alias])));
}

async function resolveValues(textFilters, contract, toolManager, toolContext, step = () => {}) {
  const quote = name => `[${String(name).replaceAll(']', ']]')}]`;
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi').trim();
  const changes = [];
  for (const target of textFilters) {
    const filter = contract.filters[target.index];
    const value = String(filter.value);
    const like = value.replace(/[%_[]/g, char => `[${char}]`).replaceAll("'", "''");
    const column = quote(target.column);
    // GROUP BY, not DISTINCT: the SQL guard prepends TOP to unlimited SELECTs.
    const sql = `SELECT TOP 6 ${column} AS [v] FROM ${quote(target.schemaName)}.${quote(target.table)} WHERE LEN(${column}) >= 2`
      + ` AND (${column} LIKE N'%${like}%' OR CHARINDEX(${column}, N'${value.replaceAll("'", "''")}') > 0) GROUP BY ${column}`;
    const probe = await toolManager.executeTool('execute_sql_query', { sql }, { ...toolContext, joinPlan: null, compiledSemanticQuery: false });
    if (!probe.success) { step('V2_VALUE_PROBE_FAILED', { code: probe.code || null, error: String(probe.error || '').slice(0, 200) }); continue; }
    const candidates = [...new Set((probe.result?.rows || []).map(row => row.v).filter(item => typeof item === 'string'))];
    if (!candidates.length || candidates.some(item => fold(item) === fold(value))) continue;
    if (candidates.length > 1) return { clarify: `Mình chưa tìm thấy giá trị “${value}”. Bạn muốn chọn giá trị nào: ${candidates.map(item => `“${item}”`).join(', ')}?`, changes };
    changes.push({ ref: filter.ref, from: value, to: candidates[0] });
    filter.resolvedFrom = value; filter.value = candidates[0];
  }
  return { changes };
}

function render(compiled, call, question) {
  const rows = call.result.rows || [];
  const analysis = require('../harness/analysis_response');
  const scope = compiled.scope.length ? `Phạm vi: ${compiled.scope.join('; ')}.` : '';
  // SUM over no matching rows still returns one row of NULLs: that is no data,
  // not a value. A COUNT of 0 is a real answer and is rendered.
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  const empty = !rows.length || (noMatch(compiled, rows) && measures.every(item => rows[0][item.alias] === null || rows[0][item.alias] === undefined));
  if (empty) return `Không tìm thấy dữ liệu phù hợp${scope ? ` với phạm vi đã lọc (${compiled.scope.join('; ')})` : ''}.`
    + ' Không có bản ghi không có nghĩa là giá trị bằng 0.';
  let body;
  if (compiled.analysis === 'anomaly') {
    const plan = { analysisTask: 'anomaly' };
    body = analysis.shortAnomalyReply(call, plan) || analysis.seriesAnomalyReply(call, plan, question)?.text || null;
  }
  if (!body) {
    if (rows.length === 1 && measures.length === compiled.outputs.length) {
      const format = value => typeof value === 'number' ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value) : value ?? '—';
      body = measures.map(item => `**${item.alias}:** ${format(rows[0][item.alias])}`).join('\n');
    } else body = require('../harness/grounded_reply').buildSqlRowsFallbackReply(call, {}, { forceTable: rows.length > 1 });
  }
  const more = call.result.hasMore ? `\n\nĐang hiển thị ${rows.length} dòng đầu; dữ liệu có thể còn thêm.` : '';
  // Matching records exist (SUM is 0, not NULL) yet every value is 0: the
  // column is probably not filled in, which "= 0" alone would hide.
  const blank = measures.filter(item => ['SUM', 'AVG'].includes(item.aggregation)
    && rows.every(row => row[item.alias] === 0 || row[item.alias] === '0'));
  const note = blank.length ? `\n\nLưu ý: ${blank.map(item => `**${item.alias}**`).join(', ')} bằng 0 ở mọi bản ghi khớp điều kiện; cột này có thể chưa được nhập dữ liệu.` : '';
  const basis = measures.filter(item => item.column).map(item => `${item.alias} = ${item.aggregation}(${item.column})`);
  const method = basis.length ? `Cách tính: ${basis.join('; ')}.\n\n` : '';
  return `${scope ? `${scope}\n` : ''}${scope && !method ? '\n' : ''}${method}${body}${more}${note}`;
}

module.exports = { run, render, decode, applyRoles, carryFilters, keepMeasures, completeFollowup, uncovered, chartArgs, describeWorkflows, previousRows, datasetChart, contractSchema };
