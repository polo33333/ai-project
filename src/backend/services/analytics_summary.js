'use strict';
const storage=require('../storage');
function compact(item) {
  return {id:item.id,status:item.status,timestamp:item.timestamp,latencyMs:item.latencyMs,
    modelName:item.modelName,providerName:item.providerName,
    estimatedTokens:Math.max(120,Math.round(((item.question||'').length+(item.replyText||'').length+(item.sqlQuery||'').length)/4)),
    requestPayload:{providerId:item.requestPayload?.providerId,tokenUsage:{totalTokens:item.requestPayload?.tokenUsage?.totalTokens||0}}};
}
async function history(account) {
  const admin=account?.role==='admin';
  if(!storage.enabled())return require('./logger_service').getChatHistory()
    .filter(item=>admin||item.requestPayload?.principalRef===`account:${account.id}`||item.requestPayload?.memoryDecision?.accountId===account.id).map(compact);
  // Match JavaScript string.length for supplementary characters (e.g. emoji)
  // so historical token estimates and cost calculations stay identical.
  const utf16Length=field=>`length(regexp_replace(COALESCE(payload->>'${field}',''), '[${String.fromCodePoint(0x10000)}-${String.fromCodePoint(0x10ffff)}]', 'xx', 'g'))`;
  const result=await storage.getPool().query(`SELECT id,
    payload->>'status' AS status,payload->>'timestamp' AS timestamp,payload->'latencyMs' AS "latencyMs",
    payload->>'modelName' AS "modelName",payload->>'providerName' AS "providerName",
    payload#>>'{requestPayload,providerId}' AS "providerId",payload#>'{requestPayload,tokenUsage}' AS usage,
    GREATEST(120,ROUND((${utf16Length('question')}+${utf16Length('replyText')}+${utf16Length('sqlQuery')}) / 4.0)) AS "estimatedTokens"
    FROM app.chat_runs WHERE $1::boolean OR payload#>>'{requestPayload,principalRef}'=$2
      OR payload#>>'{requestPayload,memoryDecision,accountId}'=$3 ORDER BY ordinal,id`,[admin,`account:${account.id}`,account.id]);
  return result.rows.map(({usage,providerId,...row})=>{
    const decoded=usage?.$khSecret===1?require('../storage/postgres/crypto').decrypt(usage,`chat_runs/${row.id}/requestPayload/tokenUsage`):usage;
    return {...row,estimatedTokens:Number(row.estimatedTokens),requestPayload:{providerId,tokenUsage:{totalTokens:Number(decoded?.totalTokens||0)}}};
  });
}
async function feedback() {
  if(!storage.enabled())return require('./logger_service').getChatFeedback().map(item=>({id:item.id,rating:item.rating,createdAt:item.createdAt,updatedAt:item.updatedAt,audit:{timestamp:item.audit?.timestamp}}));
  const result=await storage.getPool().query(`SELECT f.id,f.payload->>'rating' AS rating,
    f.payload->>'createdAt' AS "createdAt",f.payload->>'updatedAt' AS "updatedAt",r.payload->>'timestamp' AS timestamp
    FROM app.chat_feedback f LEFT JOIN app.chat_runs r ON r.id=f.run_id ORDER BY f.ordinal,f.id`);
  return result.rows.map(({timestamp,...row})=>({...row,audit:{timestamp}}));
}
module.exports={history,feedback,compact};
