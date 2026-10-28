'use strict';

// Different failures need different user actions. Retrying unchanged only
// helps transient provider/time failures; missing relationships or exhausted
// repair budgets repeat until the question or metadata changes.
const BUDGET = new Set(['REPAIR_BUDGET_EXCEEDED', 'MODEL_CALL_BUDGET_EXCEEDED', 'LOCAL_MODEL_CALL_BUDGET_EXCEEDED',
  'TOKEN_BUDGET_EXCEEDED', 'CONTEXT_BUDGET_EXCEEDED', 'TOOL_BUDGET_EXCEEDED', 'SQL_BUDGET_EXCEEDED', 'COST_BUDGET_EXCEEDED']);
const DEADLINE = new Set(['REQUEST_DEADLINE_EXCEEDED', 'LOCAL_REQUEST_DEADLINE_EXCEEDED', 'ETIMEDOUT', 'PROVIDER_TIMEOUT']);
const METADATA = new Set(['JOIN_RELATIONSHIP_MISSING', 'JOIN_SCOPE_DENIED', 'JOIN_PLAN_SOURCE_MISMATCH']);

function category(stopReason, toolCalls = []) {
  if (stopReason === 'TOOL_CAPABILITY_UNAVAILABLE') return 'UNSUPPORTED';
  const lastRejected = [...toolCalls].reverse().find(call => !call.success)?.code;
  if (METADATA.has(lastRejected) && !toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success)) return 'METADATA_REQUIRED';
  if (BUDGET.has(stopReason)) return 'BUDGET_EXHAUSTED';
  if (DEADLINE.has(stopReason) || /TIMEOUT|RATE_LIMIT|429|PROVIDER/.test(String(stopReason || ''))) return 'RETRYABLE_FAILURE';
  return 'INCOMPLETE';
}

const replies = {
  UNSUPPORTED: 'Model hiện tại chưa hỗ trợ công cụ cần thiết để hoàn thành yêu cầu này. Vui lòng chọn model hỗ trợ công cụ.',
  METADATA_REQUIRED: 'Chưa thể hoàn tất yêu cầu: câu hỏi cần kết hợp dữ liệu từ nhiều bảng nhưng chưa có quan hệ đã xác minh phù hợp giữa các bảng này. Thử lại nguyên văn sẽ cho kết quả tương tự; cần khai báo/xác minh quan hệ trong Từ điển dữ liệu, hoặc hỏi trong phạm vi một bảng.',
  BUDGET_EXHAUSTED: 'Chưa thể hoàn tất yêu cầu: đã dùng hết giới hạn xử lý trước khi có kết quả được kiểm chứng. Thử lại nguyên văn thường cho kết quả tương tự; hãy nêu rõ chỉ tiêu, kỳ và điều kiện lọc, hoặc tách thành các câu hỏi nhỏ hơn.',
  RETRYABLE_FAILURE: 'Chưa thể hoàn tất yêu cầu: model hoặc nguồn dữ liệu không phản hồi kịp. Vui lòng thử lại sau ít phút; nếu lặp lại, hãy thu hẹp phạm vi câu hỏi.',
  INCOMPLETE: 'Chưa thể hoàn tất yêu cầu. Vui lòng thử lại.'
};

function fallbackReply(stopReason, toolCalls) { return replies[category(stopReason, toolCalls)]; }

module.exports = { category, fallbackReply };
