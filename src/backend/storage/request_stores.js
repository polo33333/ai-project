'use strict';
// Unknown routes and mutations retain the full operation scope. Limit only
// routes whose store dependencies are explicitly known; never cache auth.
const auth=['accounts.json','sessions.json','account_roles.json','account_function_groups.json'];
const dictionaryFiles=['dictionary.json','table_relationships.json','db_sources.json','domain_aliases.json','glossary.json','logs.json'];
const mutations=new Map([
  ['POST /api/auth/logout',[]],
  // Attachment answers pick a model from the provider catalog.
  ['POST /api/chat/attachments',['ai_providers.json','chat_history.json']],
  ['DELETE /api/chat/attachments',[]],
  // Limits and counters live in their own SQL tables; only names come from stores.
  ['PUT /api/ai-usage/limits',['ai_providers.json','logs.json']],
  ['POST /api/ai-usage/reset',['ai_providers.json','logs.json']],
  ['POST /api/page-chat/sessions',['ai_providers.json']],
  ['PUT /api/settings',[]],
  ['POST /api/persona',['ai_persona.json','logs.json']],
  ['POST /api/tools/state',['mcp_servers.json','tool_settings.json','logs.json']],
  ...['add','update','activate','delete','test','fetch-models'].map(action=>[
    `POST /api/ai-providers/${action}`,['ai_providers.json','logs.json']]),
  ...['toggle-active','update-table','update-column','save-table-configuration','domains/save','domains/delete',
    'relationships/add','relationships/add-many-to-many','relationships/delete','relationships/update',
    'relationships/status','relationships/preview','relationships/discover','relationships/profile'].map(action=>[
    `POST /api/dictionary/${action}`,dictionaryFiles])
]);
const routes=new Map([
  ['/api/auth/me',[]], ['/api/page-chat/sessions',[]],
  ['/api/chat/attachments/file',[]], ['/api/chat/attachments',[]],
  ['/api/accounts',[]],
  ['/api/accounts/embed-identity',['embed_chat_configs.json']],
  ['/api/accounts/roles',['db_sources.json','library.json']],
  ['/api/backups',[]], ['/api/backups/status',[]],
  ['/api/memory',['long_term_memory.json','db_sources.json','library.json']],
  ['/api/memory/events',['episodic_memory.json','db_sources.json','library.json']],
  // These definitions/runs live in their own SQL repository, not JSON stores.
  ['/api/workflow-plugins',[]], ['/api/question-templates',[]],
  // Full run views resolve presentation through the current dictionary.
  ['/api/automation-runs',['dictionary.json','table_relationships.json','db_sources.json','library.json']],
  ['/api/persona',['ai_persona.json']],
  ['/api/ai-providers',['ai_providers.json']],
  ['/api/ai-usage',['ai_providers.json']], ['/api/ai-usage/me',[]],
  ['/api/chat/providers',['ai_providers.json']],
  ['/api/sql/sources',['db_sources.json']],
  ['/api/dictionary',['dictionary.json','db_sources.json','table_relationships.json']],
  ['/api/dictionary/workspace',['dictionary.json','domain_aliases.json','table_relationships.json','db_sources.json']],
  ['/api/dictionary/sync-status',[]],
  ['/api/dictionary/domains',['domain_aliases.json']],
  ['/api/qdrant/status',[]], ['/api/settings',[]],
  ['/api/governance/resources',['db_sources.json','library.json','ai_providers.json','watchfolders.json','embed_chat_configs.json','dictionary.json','table_relationships.json']],
  ['/api/governance/effective',['db_sources.json','library.json','ai_providers.json','watchfolders.json','embed_chat_configs.json','dictionary.json','table_relationships.json']],
  ['/api/governance/function-groups',['db_sources.json','library.json','watchfolders.json']],
  ['/api/governance/metrics',['db_sources.json']],
  ['/api/governance/operations',[]],
  ['/api/library',['library.json','watchfolders.json']],
  ['/api/providers',['ai_providers.json']],
  ['/api/glossary',['glossary.json']],
  // Relationship normalization resolves source/target identities from the dictionary.
  ['/api/dictionary/relationships',['table_relationships.json','dictionary.json','db_sources.json']],
  ['/api/embed/configs',['embed_chat_configs.json']],
  ['/api/logs',['logs.json']],
  ['/api/chat-history',['chat_history.json','chat_feedback.json']],
  ['/api/chat-feedback',['chat_feedback.json','chat_history.json']],
  ['/api/mcp/servers',['mcp_servers.json']],
  ['/api/keys',['api_keys.json']],
  ['/api/tools',['mcp_servers.json','tool_settings.json']],
  ['/api/training-report',['chat_feedback.json','training_resolutions.json']],
  ['/api/training/skills',['skills.json']],
  ['/api/watchfolder',['watchfolders.json']],
  ['/api/watchfolder/logs',['watchfolder_logs.json']],
  ['/api/workflows',['workflows.json','mcp_servers.json','tool_settings.json']],
  ['/api/workflows/runs',['workflow_runs.json','mcp_servers.json','tool_settings.json']],
]);
function requestStores(req) {
  let pathname=new URL(req.url,'http://localhost').pathname;
  // The chat (/chat) and admin (/admin) clients serve the same routes under their prefix (see
  // routes/router.js). The chat pages read the embed settings to decide which sites may frame them.
  const client=/^\/(chat|admin)(?=\/|$)/.exec(pathname)?.[1];
  if (client) pathname=pathname.slice(client.length+1)||'/';
  if (client==='chat'&&['/','/login'].includes(pathname)) return [...auth,'embed_chat_configs.json'];
  // Hosted MCP executes the same authoring operations as the workflow UI.
  if (pathname.startsWith('/mcp/') || pathname.startsWith('/.well-known/')) return undefined;
  if (!pathname.startsWith('/api/')) return auth;
  if(req.method==='GET'&&pathname==='/api/chat-history/export')return auth;
  if(req.method==='GET'&&pathname==='/api/chat-history'&&(new URL(req.url,'http://localhost').searchParams.get('list')==='1'||new URL(req.url,'http://localhost').searchParams.has('id')))return auth;
  if(req.method==='GET'&&pathname==='/api/chat-feedback'&&new URL(req.url,'http://localhost').searchParams.get('list')==='1')return auth;
  if(req.method==='GET'&&new URL(req.url,'http://localhost').searchParams.get('summary')==='1'
    &&['/api/chat-history','/api/chat-feedback'].includes(pathname))return auth;
  const mutation = mutations.get(`${req.method} ${pathname}`);
  if (mutation) return [...auth,...mutation];
  // Polling a run must not reconstruct the entire chat history. Run documents
  // live in the automation repository; presentation reads current schema only.
  if (req.method === 'GET' && /^\/api\/automation-runs\/[^/]+$/.test(pathname))
    return [...auth, 'dictionary.json', 'table_relationships.json','db_sources.json','library.json'];
  if (req.method === 'GET' && /^\/api\/automation-runs\/[^/]+\/(?:events|artifacts\/[^/]+)$/.test(pathname)) return [...auth,'db_sources.json','library.json'];
  if(req.method==='GET'&&/^\/api\/library\/[^/]+\/(?:content|file)$/.test(pathname)) return [...auth,'library.json'];
  if ((req.method==='GET'||pathname==='/api/page-chat/sessions')&&routes.has(pathname)) return [...auth,...routes.get(pathname)];
  return undefined;
}
module.exports={requestStores};
