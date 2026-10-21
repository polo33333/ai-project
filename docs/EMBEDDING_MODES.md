# Chuyển chế độ tìm kiếm

Đặt `EMBEDDING_ENABLED=false` trong `.env` để chạy không embedding. Sau khi lưu, khởi động lại backend.

- Schema SQL: tìm theo tên bảng/cột, mô tả, thuật ngữ và alias; vẫn lọc theo nguồn SQL.
- Tài liệu: đọc/chia đoạn/lưu manifest như bình thường, tìm bằng BM25 và graph trong phạm vi tài liệu được cấp quyền. Không gọi embedding hoặc Qdrant để tìm kiếm/lập chỉ mục.
- Workflow mới: agent đọc danh mục được cấp quyền như trước. Retrieval workflow legacy tự dùng lexical dù cấu hình phương pháp là hybrid.
- `npm start` không bắt buộc Qdrant và không kiểm tra model embedding Ollama ở chế độ này. Model chat vẫn cần được cấu hình riêng. Reranker là dịch vụ độc lập, chỉ gọi nếu `RERANKER_ENABLED=true`.
- Vector hiện có được giữ lại, không thay bằng vector giả. Xóa tài liệu lúc embedding tắt không kết nối Qdrant; các point cũ bị loại bởi phạm vi tài liệu và revision khi tìm kiếm, chưa được xóa vật lý.

Đặt `EMBEDDING_ENABLED=true`, khởi động lại, đồng bộ schema và dùng chức năng lập lại chỉ mục thư viện để tạo vector cho tài liệu đã thêm/sửa khi tắt. Endpoint/model/số chiều phải khớp collection; đổi model cần collection phù hợp và lập lại chỉ mục. Nếu không khai báo flag, giữ hành vi bật embedding của các bản cũ.

Chế độ từ khóa có thể bỏ sót câu hỏi diễn đạt quá khác tài liệu. Bổ sung mô tả và từ đồng nghĩa nghiệp vụ để cải thiện. Chế độ này không dùng `EMBEDDING_FALLBACK_MODE=deterministic`.

# Cấu hình kiến trúc agent

`GOVERNED_CONTROLLER_MODE=agent` là luồng mặc định. Nhóm `CHAT_ROUTING_*`, `CHAT_QUICK_GREETING_*`, `AGENT_CORE_ENABLED`, `LOCAL_MODEL_HARNESS_ENABLED` chỉ áp dụng với `legacy`; trang Cài đặt ẩn nhóm này ở chế độ agent. Giá trị được giữ để chuyển về tương thích có chủ đích; lưu chế độ legacy và tải lại Cài đặt để xem nhóm, khởi động lại để áp dụng runtime.

Các biến không có consumer đã được comment trong `.env`/`.env.example` và loại khỏi UI: `AI_MEMORY_RECENT_MESSAGES`, `AI_MEMORY_SUMMARY_CHARS`, `AI_DOCUMENT_CONTEXT_CHARS`, `AI_DOCUMENT_MIN_SCORE`, `AI_CONVERSATION_HISTORY`, `MEMORY_SEMANTIC_ROUTING_ENABLED`.

Ngân sách ngữ cảnh tài liệu hiện dùng `AI_DOCUMENT_CONTEXT_TOKENS`. Cấu hình provider, giới hạn ngân sách agent, memory, SQL và connector vẫn được giữ vì còn tham gia runtime.
