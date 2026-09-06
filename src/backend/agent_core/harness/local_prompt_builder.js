'use strict';

function toolSummary(definitions) {
  return definitions.map(definition => {
    const fn = definition.function || definition;
    const required = fn.parameters?.required || [];
    return `- ${fn.name}${required.length ? ` (required: ${required.join(', ')})` : ''}`;
  }).join('\n');
}

function buildLocalMessages(messages = [], definitions = [], requestPolicy = {}) {
  const protocol = definitions.length ? `

# Local tool protocol
Use a tool only when it is needed. Prefer the native function-calling interface.
If native function calling is unavailable, output exactly one JSON object and no surrounding prose:
{"tool":"tool_name","arguments":{"key":"value"}}
Available tools:
${toolSummary(definitions)}
Never invent a tool or argument. After receiving a tool result, either call the next necessary tool or answer the user. Do not reveal private reasoning.
${requestPolicy.chartRequired ? 'This request requires a real chart. You must call execute_sql_query and then render_chart. Never create image URLs or chart placeholders. Do not finish before render_chart succeeds.' : ''}
${requestPolicy.exportRequired ? 'This request requires a real downloadable file. After obtaining rows, call export_data with those rows. Do not finish before export_data succeeds.' : ''}
${requestPolicy.dataRequired ? 'For a data request, execute the query with execute_sql_query. Do not merely print SQL or ask for confirmation.' : ''}
${requestPolicy.temporalMonths ? `For the latest ${requestPolicy.temporalMonths} months, use the latest date present in the database as the anchor, not the current system date. Aggregate rows into year/month buckets; TOP ${requestPolicy.temporalMonths} raw database rows is not a valid monthly result.` : ''}` : '';

  let systemSeen = false;
  return messages.map(message => {
    if (message.role !== 'system' || systemSeen) return message;
    systemSeen = true;
    return { ...message, content: `${message.content || ''}${protocol}`.trim() };
  });
}

module.exports = { buildLocalMessages };
