'use strict';

// Independent check that a query contract covers what the question names.
// Codes and dates are found by pattern; business values (status, gender,
// department, period name, customer name...) are found by matching the
// question against the values each foreign key of the root actually uses.
// A term may be declared not-a-criterion in contract.ignoredTerms.
const catalogApi = require('./query_catalog');
const { compile } = require('./query_compiler');

const CACHE_MS = 10 * 60 * 1000, MAX_VALUES = 500;
const cache = new Map();
const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi').replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, term) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
const EXCLUSION = /(^|[^\p{L}])(trừ|ngoại trừ|không phải|không bao gồm|loại trừ|không tính|except|excluding)(?=$|[^\p{L}])/iu;

// Display values used by each foreign key of the root, e.g. T_Feedback.StatusID
// -> {"Đã xử lý", "Đang xử lý", "Tiếp nhận"}. Built with the compiler, so the
// lookup query passes the same JOIN validation as answers.
async function lookupTerms(root, catalog, execute) {
  // Each foreign key is an independent read: query the uncached ones together.
  const entries = await Promise.all(catalog.relations.filter(item => catalogApi.key(item.fromTable) === catalogApi.key(root) && item.display).map(async relation => {
    const ref = `${relation.fromTable}.${relation.pairs[0].source}->${relation.display}`;
    const id = `${catalog.dbSourceId}|${ref}`;
    let entry = cache.get(id);
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      try {
        const query = compile({ root, operation: 'aggregate', groupBy: [{ ref }], measures: [{ ref: '*', aggregation: 'COUNT' }], limit: MAX_VALUES + 1 }, catalog);
        const rows = await execute(query);
        const alias = query.outputs.find(item => item.kind === 'dimension')?.alias;
        const values = rows && rows.length <= MAX_VALUES ? rows.map(row => row[alias]).filter(value => typeof value === 'string' && fold(value).length >= 2) : [];
        entry = { at: Date.now(), values };
      } catch { entry = { at: Date.now(), values: [] }; }
      cache.set(id, entry);
    }
    return { entry, ref, role: relation.role };
  }));
  return entries.flatMap(({ entry, ref, role }) => entry.values.map(value => ({ value, ref, role })));
}

function covered(contract, term) {
  const term_ = fold(term);
  const filters = (contract.filters || []).map(filter => fold([filter.evidence, filter.value, ...(filter.values || [])].join(' ')));
  return filters.some(text => text.includes(term_))
    || (contract.ignoredTerms || []).some(item => fold(item).includes(term_) || term_.includes(fold(item)));
}

// Problems to send back to the model; empty when the contract covers the question.
function check(contract, question, terms) {
  const text = fold(question);
  const problems = [];
  const missing = [];
  for (const term of terms) if (mentions(text, fold(term.value)) && !covered(contract, term.value)
    && !missing.some(item => fold(item.value) === fold(term.value))) missing.push(term);
  // A value that is part of a longer matched value ("Kỳ 1" inside "Kỳ 12") is not separate.
  const named = missing.filter(term => !missing.some(other => other !== term && fold(other.value).includes(fold(term.value))));
  if (named.length) problems.push(`the question names ${named.map(term => `"${term.value}" (${term.role || 'value'}: ${term.ref})`).join(', ')} but no filter uses it. Add the filter, or list the words in ignoredTerms if they are not a criterion`);
  const exclusion = text.match(EXCLUSION);
  if (exclusion && !(contract.filters || []).some(filter => ['ne', 'notIn'].includes(filter.operator))
    && !(contract.ignoredTerms || []).some(item => fold(item).includes(fold(exclusion[2])))) {
    problems.push(`the question excludes something ("${exclusion[2]}") but no filter uses operator ne/notIn. Add it, or put "${exclusion[2]}" in ignoredTerms if it is not an exclusion`);
  }
  return problems;
}

module.exports = { lookupTerms, check, mentions, cache };
