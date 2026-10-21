'use strict';
const features = [
  ['chat.use',['/page-chat','/views/page_chat.html','/api/intelligent-core/chat','/api/chat','/api/page-chat']],
  ['sql:read',['/api/text2sql']],
  ['schema.read',['/dictionary','/views/dictionary.html','/api/dictionary']],
  ['sources.read',['/sql','/views/sql_connector.html','/api/sql']],
  ['library.read',['/library','/views/library.html','/api/library','/api/documents']],
  ['glossary.read',['/glossary','/views/glossary.html','/api/glossary']],
  ['workflows.use',['/workflows','/views/workflows.html','/api/automation-runs','/api/question-templates']],
  ['history.read',['/chat-history','/views/chat_history.html','/api/chat-history']],
  ['feedback.read',['/chat-feedback','/views/chat_feedback.html','/api/chat-feedback']],
  ['analytics.read',['/analytics','/views/analytics.html','/api/analytics']],
  ['memory.use',['/memory','/views/memory.html','/api/memory']],
  ['dashboard.read',['/','/views/dashboard_logs.html','/api/dashboard']]
];
function allowed(account,path) {
  if(path==='/') return true; // The app shell remains available for logout/profile.
  if (account?.role==='admin'||!Array.isArray(account?.permissions)) return true;
  if(path==='/api/chat/providers'&&account.permissions.some(p=>['chat.use','dashboard.read','analytics.read'].includes(p))) return true;
  if(account.permissions.includes('chat.use')&&((path==='/api/sql/sources'&&account.permissions.includes('sql:read'))||(path==='/api/library'&&account.permissions.includes('knowledge:read')))) return true;
  const match=features.find(([,paths])=>paths.some(prefix=>path===prefix||(prefix!=='/'&&path.startsWith(prefix+'/'))));
  return !match || account.permissions.includes(match[0]);
}
module.exports={allowed,features};
