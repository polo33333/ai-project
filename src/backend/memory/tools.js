'use strict';
const definitions = [
  { name: 'recall_memory', description: 'Tìm sở thích cá nhân, hướng dẫn tổ chức đã duyệt hoặc tác vụ trước đây. Không phải nguồn số liệu hiện tại. Chỉ trả về bộ nhớ được phép của tài khoản hiện tại.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      query: { type: 'string', maxLength: 300 }, kind: { type: 'string', enum: ['preferences', 'events'] },
      limit: { type: 'integer', minimum: 1, maximum: 10 }, offset: { type: 'integer', minimum: 0 } } } },
  { name: 'remember_preference', description: 'Lưu hoặc sửa sở thích trình bày/chỉ dẫn cá nhân CHỈ khi người dùng yêu cầu ghi nhớ rõ ràng trong câu hiện tại. Không lưu dữ kiện nhân viên, số liệu, suy đoán hay bí mật. Không chia sẻ cho tổ chức. quote phải trích nguyên văn yêu cầu người dùng.',
    parameters: { type: 'object', additionalProperties: false, required: ['title', 'content', 'quote'], properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 }, content: { type: 'string', minLength: 1, maxLength: 2000 },
      quote: { type: 'string', minLength: 1, maxLength: 2000 }, id: { type: 'string' }, revision: { type: 'integer', minimum: 1 } } } },
  { name: 'forget_memory', description: 'Xóa sở thích cá nhân khi người dùng yêu cầu quên/xóa rõ ràng. Tra cứu bộ nhớ trước để lấy đúng id và revision. Không xóa hướng dẫn tổ chức.',
    parameters: { type: 'object', additionalProperties: false, required: ['id', 'revision', 'quote'], properties: {
      id: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 2000 } } } }
];
async function execute(name, args, context = {}) {
  await require('../governance/context').refresh();
  const { memory } = require('./durable_memory');
  if (name === 'recall_memory') {
    const result = args.kind === 'events'
      ? await require('./semantic_recall').recall(memory, { ...args, limit: args.limit || 5 })
      : memory.list({ ...args, events: false, limit: args.limit || 5, register: true, approvedOnly: true });
    return { ...result, items: result.items.map(item => args.kind === 'events'
      ? { id: item.id, revision: item.revision, question: item.question, sessionId: item.sessionId, runId: item.runId,
        table: item.table, dbSourceId: item.dbSourceId, updatedAt: item.updatedAt, status: item.status,
        instruction: 'Historical task reference only; re-authorize and query the source for current business data.' }
      : { id: item.id, revision: item.revision, scope: item.scope, title: item.title, content: item.content, status: item.status }) };
  }
  if (name === 'remember_preference') return memory.save({ ...args, scope: 'personal' },
    { source: 'chat', quote: args.quote, userMessage: context.userMessage });
  if (name === 'forget_memory') {
    if (!args.quote || !String(context.userMessage || '').includes(args.quote)) throw new Error('Thiếu yêu cầu xóa từ người dùng hiện tại.');
    return memory.remove(args.id, args.revision, false, 'personal');
  }
  throw new Error('MEMORY_TOOL_UNKNOWN');
}
function available() {
  const principal = require('../governance/context').principal();
  return process.env.MEMORY_DURABLE_ENABLED !== 'false' && (!principal || principal.channel !== 'embed');
}
module.exports = { definitions, execute, available };
