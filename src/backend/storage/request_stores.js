'use strict';
// Unknown routes and mutations retain the full operation scope. Limit only
// routes whose store dependencies are explicitly known; never cache auth.
const auth=['accounts.json','sessions.json'];
const routes=new Map([
  ['/api/auth/me',[]], ['/api/page-chat/sessions',[]],
  ['/api/persona',['ai_persona.json']],
  ['/api/ai-providers',['ai_providers.json']],
  ['/api/sql/sources',['db_sources.json']],
  ['/api/dictionary',['dictionary.json']],
  ['/api/dictionary/domains',['domain_aliases.json']],
  ['/api/qdrant/status',[]], ['/api/settings',[]],
  ['/api/library',['library.json']],
  ['/api/providers',['ai_providers.json']],
  ['/api/glossary',['glossary.json']],
  // Relationship normalization resolves source/target identities from the dictionary.
  ['/api/dictionary/relationships',['table_relationships.json','dictionary.json']],
  ['/api/embed/configs',['embed_chat_configs.json']],
  ['/api/logs',['logs.json']],
  ['/api/chat-history',['chat_history.json','chat_feedback.json']],
  ['/api/chat-feedback',['chat_feedback.json','chat_history.json']],
  ['/api/mcp/servers',['mcp_servers.json']],
  ['/api/keys',['api_keys.json']],
  ['/api/tools',['mcp_servers.json']],
  ['/api/training-report',['chat_history.json','chat_feedback.json','training_resolutions.json']],
  ['/api/training/skills',['skills.json']],
  ['/api/watchfolder',['watchfolders.json']],
  ['/api/watchfolder/logs',['watchfolder_logs.json']],
  ['/api/workflows',['workflows.json','mcp_servers.json']],
  ['/api/workflows/runs',['workflow_runs.json','mcp_servers.json']],
]);
function requestStores(req) {
  const pathname=new URL(req.url,'http://localhost').pathname;
  if (!pathname.startsWith('/api/')) return auth;
  if(req.method==='GET'&&/^\/api\/library\/[^/]+\/(?:content|file)$/.test(pathname)) return [...auth,'library.json'];
  if ((req.method==='GET'||pathname==='/api/page-chat/sessions')&&routes.has(pathname)) return [...auth,...routes.get(pathname)];
  return undefined;
}
module.exports={requestStores};
