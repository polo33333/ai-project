'use strict';
const storage=require('../storage');
const owner=(item,account)=>account.role==='admin'||item.requestPayload?.principalRef===`account:${account.id}`||item.requestPayload?.memoryDecision?.accountId===account.id||item.requestPayload?.account?.id===account.id;
const error=()=>Object.assign(new Error('Không tìm thấy lượt chat.'),{statusCode:404});
async function records(ids) {
  if(!ids.length)return [];
  if(!storage.enabled())return require('./logger_service').chatHistory.filter(item=>ids.includes(item.id));
  const {decode}=require('../storage/postgres/codec');
  return require('../storage/postgres/pool').transaction(storage.getPool(),async client=>{
    const rows=(await client.query('SELECT id,payload,child_fields FROM app.chat_runs WHERE id=ANY($1::text[]) ORDER BY ordinal,id',[ids])).rows;
    const children=(await client.query('SELECT id,parent_id,payload FROM app.tool_executions WHERE parent_id=ANY($1::text[]) ORDER BY ordinal,id',[ids])).rows;
    const byRun=new Map();for(const child of children){if(!byRun.has(child.parent_id))byRun.set(child.parent_id,[]);byRun.get(child.parent_id).push(decode('tool_executions',child.id,child.payload));}
    return rows.map(row=>{
      const item=decode('chat_runs',row.id,row.payload);
      if(row.child_fields?.includes('requestPayload.toolCalls')) {item.requestPayload||={};item.requestPayload.toolCalls=byRun.get(row.id)||[];}
      return item;
    });
  },{readOnly:true});
}
async function detail(id,account) {
  const [item]=await records([id]);
  if(!item||!owner(item,account))throw error();
  return item;
}
function listItem(item) {
  const p=item.requestPayload||{};
  return {id:item.id,status:item.status,timestamp:item.timestamp,question:item.question,modelName:item.modelName,
    latencyMs:item.latencyMs,errorReason:item.errorReason,feedback:item.feedback,
    requestPayload:{endpoint:p.endpoint,embedId:p.embedId,visitorIdentity:p.visitorIdentity,account:p.account,sessionId:p.sessionId,origin:p.origin},detailsAvailable:true};
}
async function list(account) {
  if(!storage.enabled())return require('./logger_service').getChatHistory().filter(item=>owner(item,account)).map(listItem);
  const result=await storage.getPool().query(`SELECT r.id,r.payload->>'status' AS status,r.payload->>'timestamp' AS timestamp,
    r.payload->>'question' AS question,r.payload->>'modelName' AS "modelName",r.payload->'latencyMs' AS "latencyMs",
    r.payload->>'errorReason' AS "errorReason",f.payload->>'rating' AS feedback,
    jsonb_build_object('endpoint',r.payload#>'{requestPayload,endpoint}','embedId',r.payload#>'{requestPayload,embedId}',
      'visitorIdentity',r.payload#>'{requestPayload,visitorIdentity}','account',r.payload#>'{requestPayload,account}','sessionId',r.payload#>'{requestPayload,sessionId}',
      'origin',r.payload#>'{requestPayload,origin}') AS "requestPayload",true AS "detailsAvailable"
    FROM app.chat_runs r LEFT JOIN LATERAL (SELECT payload FROM app.chat_feedback WHERE run_id=r.id ORDER BY ordinal,id LIMIT 1) f ON true
    WHERE $1::boolean OR r.payload#>>'{requestPayload,principalRef}'=$2 OR r.payload#>>'{requestPayload,memoryDecision,accountId}'=$3
      OR r.payload#>>'{requestPayload,account,id}'=$3
    ORDER BY r.ordinal,r.id`,[account.role==='admin',`account:${account.id}`,account.id]);
  return result.rows;
}
async function feedback() {
  if(!storage.enabled())return require('./logger_service').getChatFeedback();
  const rows=(await storage.getPool().query(`SELECT f.id,f.payload,r.id AS audit_id,
    jsonb_build_object('id',r.id,'question',r.payload->'question','replyText',r.payload->'replyText',
      'sqlQuery',r.payload->'sqlQuery','modelName',r.payload->'modelName','timestamp',r.payload->'timestamp',
      'requestPayload',jsonb_build_object('tokenUsage',r.payload#>'{requestPayload,tokenUsage}')) AS audit
    FROM app.chat_feedback f LEFT JOIN app.chat_runs r ON r.id=f.run_id ORDER BY f.ordinal,f.id`)).rows;
  const {decode}=require('../storage/postgres/codec'),{decrypt}=require('../storage/postgres/crypto');
  return rows.map(row=>{
    const audit=row.audit_id?row.audit:null,usage=audit?.requestPayload?.tokenUsage;
    if(usage?.$khSecret===1)audit.requestPayload.tokenUsage=decrypt(usage,`chat_runs/${row.audit_id}/requestPayload/tokenUsage`);
    return {...decode('chat_feedback',row.id,row.payload),audit};
  });
}
module.exports={records,detail,list,listItem,feedback};
