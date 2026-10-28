'use strict';

const SUGGESTIONS = {
  MISSING_SQL: { target: 'harness', action: 'require_business_sql', title: 'Bắt buộc truy vấn dữ liệu', message: 'Không chấp nhận câu trả lời cuối khi yêu cầu dữ liệu chưa có execute_sql_query thành công.' },
  MISSING_CHART: { target: 'harness', action: 'auto_render_chart', title: 'Tự động tạo biểu đồ', message: 'Sau khi có dữ liệu hợp lệ, gọi render_chart trước khi hoàn tất.' },
  MISSING_EXPORT: { target: 'harness', action: 'auto_export_data', title: 'Tự động xuất file', message: 'Dùng tập dữ liệu chính để gọi export_data và gắn downloadUrl thật vào câu trả lời.' },
  SQL_ONLY_ANSWER: { target: 'synthesis', action: 'resynthesize_rows', title: 'Tổng hợp lại câu trả lời', message: 'Không đưa SQL thô lên UI; yêu cầu model diễn giải từ result.rows.' },
  SCHEMA_ONLY_ANSWER: { target: 'planner', action: 'continue_after_schema', title: 'Truy vấn bản ghi thực tế', message: 'Schema chỉ là bước chuẩn bị; tiếp tục chạy SQL nghiệp vụ trước khi trả lời.' },
  HISTORY_CONTAMINATION: { target: 'context', action: 'isolate_current_turn', title: 'Cô lập ngữ cảnh hiện tại', message: 'Tổng hợp bằng câu hỏi và SQL rows hiện tại, bỏ các chủ đề không liên quan trong lịch sử.' },
  MEMORY_USED_FOR_INDEPENDENT_REQUEST: { target: 'memory_router', action: 'route_none', title: 'Bỏ memory cho câu độc lập', message: 'Câu hỏi tự đủ thông tin nên phải dùng memory mode none.' },
  TOPIC_CHANGE_NOT_DETECTED: { target: 'topic_detector', action: 'detect_scope_change', title: 'Nhận diện chuyển chủ đề', message: 'So sánh bảng và domain hiện tại với plan trước.' },
  INVALID_RESPONSE_PERSISTED: { target: 'memory_policy', action: 'enforce_quality_gate', title: 'Chặn response lỗi khỏi memory', message: 'Chỉ ghi memory sau SUCCESS và response evaluator hợp lệ.' },
  MISSING_REFERENCE: { target: 'reference_store', action: 'resolve_reference', title: 'Thiếu reference', message: 'Kiểm tra reference theo session, loại và TTL.' },
  STALE_REFERENCE_USED: { target: 'reference_store', action: 'reject_stale_reference', title: 'Reference đã cũ', message: 'Không dùng reference quá TTL hoặc sai chủ đề.' },
  REVIEW_REQUESTED: { target: 'review', action: 'inspect_manually', title: 'Kiểm tra thủ công', message: 'Case đã được đánh dấu Cần xem lại nhưng rule hiện tại chưa xác định được lỗi; cần đọc câu hỏi, SQL và câu trả lời.' },
  WRONG_TABLE: { target: 'sql', action: 'replace_table', title: 'Dùng đúng bảng', message: 'Dùng bảng đứng đầu request plan hoặc bảng được người dùng nêu rõ.' },
  MISSING_TIME_BUCKET: { target: 'sql', action: 'add_time_bucket', title: 'Nhóm dữ liệu theo thời gian', message: 'Thêm bucket năm/tháng và GROUP BY thay vì lấy TOP dòng thô.' }
};

function suggestionForFailure(failure = '') {
  const [code, detail] = String(failure).split(':');
  if (code === 'MISSING_COLUMN') return { target: 'sql', action: 'add_column', title: `Bổ sung cột ${detail || ''}`.trim(), message: `SQL phải chứa cột người dùng yêu cầu: ${detail || 'cột còn thiếu'}.` };
  if (code === 'WRONG_METRIC') return { target: 'sql', action: 'replace_metric', title: `Sửa metric thành ${detail || ''}`.trim(), message: `Dùng đúng phép tổng hợp trên ${detail || 'metric được yêu cầu'}.` };
  if (code === 'WRONG_TIME_COLUMN') return { target: 'sql', action: 'replace_time_column', title: `Sửa cột thời gian ${detail || ''}`.trim(), message: `Nhóm và lọc thời gian bằng ${detail || 'cột ngày được yêu cầu'}.` };
  return SUGGESTIONS[code] || { target: 'review', action: 'manual_review', title: 'Cần kiểm tra thêm', message: `Chưa có rule tự động cho lỗi ${failure}.` };
}

function suggestForCase(item = {}) {
  return (item.failures || []).map(failure => ({ failure, ...suggestionForFailure(failure) }));
}

module.exports = { suggestionForFailure, suggestForCase };
