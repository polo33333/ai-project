'use strict';

// Fixed identifiers only. Never interpolate identifiers supplied by an HTTP client.
const sources = [
  ['accounts.json', 'accounts', 'array', 'id'],
  ['sessions.json', 'auth_sessions', 'map'],
  ['api_keys.json', 'api_keys', 'array', 'id'],
  ['db_sources.json', 'data_sources', 'array', 'id'],
  ['ai_providers.json', 'ai_providers', 'array', 'id'],
  ['ai_persona.json', 'ai_personas', 'singleton'],
  ['embed_chat_configs.json', 'embed_configs', 'array', 'id'],
  ['mcp_servers.json', 'mcp_servers', 'array', 'id'],
  ['dictionary.json', 'dictionary_tables', 'array', 'tableId'],
  ['table_relationships.json', 'table_relationships', 'array', 'id'],
  ['glossary.json', 'glossary_terms', 'array', 'id'],
  ['domain_aliases.json', 'alias_domains', 'aliases'],
  ['skills.json', 'skills', 'wrapped', 'id', 'skills'],
  ['chat_history.json', 'chat_runs', 'array', 'id'],
  ['chat_feedback.json', 'chat_feedback', 'array', 'id'],
  ['conversation_memory.json', 'chat_sessions', 'wrappedMap', 'id', 'sessions'],
  ['logs.json', 'system_logs', 'array', 'id'],
  ['workflows.json', 'workflows', 'array', 'id'],
  ['workflow_runs.json', 'workflow_runs', 'array', 'runId'],
  ['library.json', 'documents', 'array', 'id'],
  ['watchfolders.json', 'watchfolders', 'array', 'id'],
  ['watchfolder_logs.json', 'watchfolder_runs', 'array', 'id'],
  ['training_resolutions.json', 'training_resolutions', 'map'],
  ['training/regression_cases.json', 'regression_cases', 'array', 'id']
].map(([file, table, shape, idField, wrapper]) => ({ file, table, shape, idField, wrapper }));

const children = {
  dictionary_tables: [{ field: 'columns', table: 'dictionary_columns', idField: 'columnId' }],
  chat_sessions: [{ field: 'messages', table: 'chat_messages' }],
  chat_runs: [{ field: 'requestPayload.toolCalls', table: 'tool_executions' }],
  workflows: [{ field: 'steps', table: 'workflow_steps', idField: 'id' }],
  alias_domains: [{ field: 'aliases', table: 'domain_aliases' }]
};
const tables = [...sources.map(source => source.table), ...Object.values(children).flat().map(child => child.table), 'memory_states'];

module.exports = { sources, children, tables };
