'use strict';
const segmenter = new Intl.Segmenter('vi', { granularity: 'word' });
function words(text) {
  return new Set([...segmenter.segment(String(text || '').normalize('NFC').toLocaleLowerCase('vi'))]
    .filter(part => part.isWordLike).map(part => part.segment));
}
function operations(definition) {
  return require('../automation/workflow_capabilities').operations(definition);
}
function brief(definition) {
  return { templateId: definition.id, name: definition.name, description: definition.description?.slice(0, 300),
    inputs: definition.inputs, operations: operations(definition), templateVersion: definition.packageVersion };
}
function discover(definitions, { query = '', offset = 0, limit = 5, templateId } = {}) {
  // Ranking only changes order. Every authorized candidate remains discoverable.
  const terms = words(query);
  const ranked = definitions.map((definition, index) => {
    const title = words([definition.name, ...(definition.aliases || [])].join(' ')), body = words([definition.routingDescription, definition.description, definition.instructions, definition.domain, ...(definition.tags || []), ...(definition.routingExamples || [])].join(' '));
    const score = [...terms].reduce((n, term) => n + (title.has(term) ? 3 : body.has(term) ? 1 : 0), 0);
    return { definition, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (templateId) {
    const found = definitions.find(definition => definition.id === templateId);
    if (!found) throw Object.assign(new Error('WORKFLOW_NOT_AVAILABLE'), { statusCode: 403 });
    return { workflows: [{ ...brief(found), instructions: found.instructions }], total: definitions.length, hasMore: false, detail: true };
  }
  const page = ranked.slice(offset, offset + limit);
  return { workflows: page.map(item => brief(item.definition)), total: definitions.length, offset,
    hasMore: offset + limit < definitions.length, nextOffset: offset + limit < definitions.length ? offset + limit : null,
    directory: definitions.length > limit ? ranked.map(({ definition }) => ({ templateId: definition.id, name: definition.name,
      description: definition.description?.slice(0, 120), operations: operations(definition) })) : undefined,
    guidance: 'Ranking is a hint, not a suitability decision. The directory includes every authorized workflow. Inspect another candidate using templateId or expand pagination if none fits or meaning is ambiguous. Missing required inputs never exclude a workflow: select the matching business operation with available inputs; runtime asks for missing fields. Do not invent input values.' };
}
module.exports = { discover, brief, operations };
