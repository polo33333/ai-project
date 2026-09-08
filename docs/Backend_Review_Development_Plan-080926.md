# Đánh giá backend và kế hoạch phát triển KnowledgeHub AI

Ngày rà soát: 08/09/2026. Phạm vi: mã backend, entrypoint, scripts và tests trong working tree hiện tại. Đây là báo cáo rà soát tĩnh và kế hoạch thực hiện; chưa phải kết quả kiểm thử production hay xác nhận lỗi đã được sửa.

## 1. Kết luận tổng quan

Backend phù hợp cho MVP self-hosted, đã có xử lý chat, Text-to-SQL, tool calling, retrieval tài liệu, memory theo hội thoại và đánh giá chất lượng. Điểm cần ưu tiên là bảo vệ secret/quyền truy cập, tính bền vững của dữ liệu JSON và kiểm thử tích hợp. Chưa nên coi việc unit test thành công là đủ điều kiện triển khai nhiều người dùng trên Internet.

Kiến trúc nên tiếp tục phát triển theo module trong một ứng dụng trước khi tách dịch vụ. Việc đổi framework HTTP không tự giải quyết lỗi lưu trữ, phân quyền hay chất lượng câu trả lời. Chỉ tách ingestion thành worker khi đã xác định contract, trạng thái job và cách phục hồi.

## 2. Các khối chức năng hiện có

| Khối | Vai trò và mức hoàn thiện | Nguồn mã |
|---|---|---|
| HTTP server/router | node:http, session authentication, REST, static files; router tập trung nhiều trách nhiệm | [server.js](../server.js), [router.js](../src/backend/routes/router.js) |
| Intelligent Core | Điều phối chat, adapters, schema context và kiểm tra SQL | [intelligent_core](../src/backend/intelligent_core/) |
| Agent Core | Local Model Harness, kiểm tra tool arguments, phục hồi lỗi và workflow engine | [agent_core](../src/backend/agent_core/) |
| Memory Core | Định tuyến ngữ cảnh, references, làm sạch dữ liệu và quality gate trước khi lưu | [memory_core](../src/backend/memory_core/) |
| Knowledge Core | Library, Watch Folder, embedding/retrieval; phụ thuộc dịch vụ ngoài cho dense search | [knowledge_core](../src/backend/knowledge_core/) |
| Training Core | Lập kế hoạch yêu cầu, thu thập case, đánh giá SQL/response, phân loại lỗi, báo cáo và đề xuất; không đồng nghĩa fine-tuning model | [training_core](../src/backend/training_core/) |
| Services | SQL Server, Qdrant, providers, auth, API keys, settings, audit, web search | [services](../src/backend/services/) |
| Persistence | Metadata JSON và file cục bộ, chưa có transaction chung giữa metadata/file/vector | [storage_helper.js](../src/backend/utils/storage_helper.js) |
| MCP | Quản lý cấu hình server; chưa có handshake/discovery/execution trong service này | [mcp_service.js](../src/backend/services/mcp_service.js) |

Luồng chat chính: HTTP → xác thực/giới hạn request → core/harness → context + memory → adapter LLM → tools SQL/retrieval/chart/export → đánh giá kết quả → audit/memory → phản hồi. Endpoint `/api/intelligent-core/chat/stream` trả sự kiện tiến trình và kết quả cuối; không nên mô tả là streaming token đầy đủ của mọi provider.

## 3. Lỗi và hạn chế còn tồn đọng

P0: cần xử lý trước khi mở rộng quyền truy cập. P1: độ ổn định và tính đúng đắn. P2: khả năng mở rộng, bảo trì. “Xác nhận mã” nghĩa là đã thấy đường mã gây vấn đề, chưa khai thác trên server thật.

| ID | Ưu tiên / bằng chứng | Vấn đề và tác động | Hướng xử lý / nghiệm thu |
|---|---|---|---|
| BE-01 | P0 · xác nhận mã | `getProviders()` spread `...p` rồi thêm `apiKeyMasked`, vẫn giữ `apiKey` gốc. Mask không loại secret khỏi object trả về. | DTO allowlist; chỉ trả `hasApiKey`/mask. Test GET/list/test/error response không chứa key gốc. [Nguồn](../src/backend/services/ai_provider_manager.js) |
| BE-02 | P0 · xác nhận mã | Auth dùng SHA-256 không salt và tự tạo admin với mật khẩu cố định khi kho account rỗng. | Password hashing có salt và chi phí tính toán, bootstrap secret một lần, migration hash cũ. Test đăng nhập/migration/session invalidation. [Nguồn](../src/backend/services/auth_service.js) |
| BE-03 | P0 · cần kiểm chứng ma trận quyền | Router có gate đăng nhập và kiểm tra admin ở một số nhánh, nhưng cần kiểm toán quyền từng endpoint quản trị/tài liệu/export. Cookie có HttpOnly/SameSite=Lax, thiếu Secure; CORS mặc định wildcard. | Ma trận route × role × resource; deny-by-default; kiểm tra origin/CSRF cho mutation; Secure khi HTTPS; test tài khoản không có quyền không đọc/sửa tài nguyên khác. [Nguồn](../src/backend/routes/router.js) |
| BE-04 | P1 · xác nhận mã | `saveJson()` ghi đè đồng bộ, bắt lỗi rồi chỉ log; bên gọi không biết ghi thất bại. Có nguy cơ hỏng file khi bị ngắt giữa chừng và báo thành công dù chưa lưu. | Ghi tạm + atomic rename, truyền lỗi lên caller, serialize cập nhật; test hết quyền ghi/file lỗi/interruption trên thư mục tạm. [Nguồn](../src/backend/utils/storage_helper.js) |
| BE-05 | P1 · xác nhận mã, tác động cần đo | `getAccountBySession()` gia hạn và ghi toàn bộ sessions JSON mỗi request hợp lệ, chặn event loop bằng sync I/O. | Giảm tần suất persist/tách session store; đo p95 latency và event-loop lag theo số session. [Nguồn](../src/backend/services/auth_service.js) |
| BE-06 | P1 · xác nhận mã | Entry HTTP không await/catch promise của `router.handleRequest`; lỗi trước các catch của route có thể thành unhandled rejection. `parseCookies()` decode dữ liệu client có thể throw. | Catch ở biên HTTP, trả 400 cho cookie/URL sai; test malformed input không làm server mất khả dụng. [Nguồn](../server.js), [router](../src/backend/routes/router.js) |
| BE-07 | P1 · hạn chế thiết kế cần integration test | SQL guard dựa vào chuỗi/regex và thêm TOP theo heuristic; chưa đủ bằng chứng mọi CTE/subquery/batch đều được giới hạn đúng. | DB account chỉ SELECT, timeout/row limit nhất quán, test SQL corpus và SQL Server test instance; không khẳng định regex là ranh giới bảo mật đầy đủ. [Nguồn](../src/backend/intelligent_core/security_guard.js) |
| BE-08 | P1 · rủi ro cần thử phục hồi | Ingestion và metadata/file/vector thiếu transaction chung; worker chết, Qdrant/embedding timeout có thể để trạng thái lệch. | Job bền vững, idempotency theo version, reconciliation và retry hữu hạn; kill/restart và outage test. [Nguồn](../src/backend/knowledge_core/) |
| BE-09 | P1 · xác nhận mã | `server.listen(PORT)` không chỉ định host, không bảo đảm chỉ bind localhost. Shutdown chưa có thời hạn cưỡng chế và xử lý lỗi rõ ràng. | HOST cấu hình được, readiness/liveness, drain request có deadline; test khởi động thiếu phụ thuộc và SIGTERM. [Nguồn](../server.js) |
| BE-10 | P2 · hạn chế kiểm thử | Tests tập trung logic/module; chưa có bằng chứng từ lần rà soát này về E2E HTTP auth→LLM→SQL→audit, tải đồng thời và khôi phục backup. | Thêm integration suite cô lập và smoke test với dịch vụ thật; đo và lưu baseline trước tối ưu. [Nguồn](../tests/) |
| BE-11 | P2 · nợ kỹ thuật | Router lớn, nhiều lớp core/service cùng tồn tại khiến việc xác định đường thực thi và contract khó hơn. | Tách router theo domain, chuẩn hóa request/result/error, ghi rõ facade/legacy; giữ compatibility test trước khi loại mã. [Nguồn](../src/backend/routes/router.js) |

Các mục trên vẫn mở. Những thay đổi UI trước đó không được tính là đã sửa các vấn đề backend này. Không đưa secret hoặc nội dung hội thoại thật vào báo cáo/test fixture.

## 4. Hướng phát triển theo giai đoạn

### Giai đoạn A — Bảo mật và bảo toàn dữ liệu

- [ ] BE-01: loại secret khỏi response/log; kiểm tra các đường provider/test/export cấu hình.
- [ ] BE-02/03: migration password, bootstrap, ma trận quyền, cookie/CORS/CSRF theo deployment.
- [ ] BE-04/06: lỗi persistence có thể quan sát, atomic writes và exception boundary.
- [ ] Thêm test HTTP với user/admin, dữ liệu lỗi và storage failure bằng fixtures cô lập.

Đầu ra nghiệm thu: request không có quyền bị từ chối, secret không xuất hiện trong response, lỗi ghi không trả success, malformed request không làm chết tiến trình. Ưu tiên giai đoạn này trước khi bổ sung chức năng mới.

### Giai đoạn B — Vận hành ổn định và đo hiệu năng

- [ ] BE-05/09: giảm ghi session, cấu hình bind, startup/readiness/shutdown.
- [ ] Gắn request ID xuyên HTTP → harness → tool → audit; đo thời gian chờ LLM, SQL, retrieval và ghi dữ liệu riêng.
- [ ] Benchmark với 1/5/20 request đồng thời, nhiều mức lịch sử/tài liệu; lưu p50/p95/error rate/event-loop lag. Đây là kịch bản đề xuất, chưa phải công suất được chứng minh.
- [ ] Integration test hủy request, provider timeout, Qdrant mất kết nối, SQL chậm và retry không tạo export trùng.
- [ ] Backup/restore metadata và file, kiểm chứng khả năng reindex Qdrant sau restore.

Đầu ra nghiệm thu: baseline tái lập được, timeout/hủy không để job vô hạn, không mất dữ liệu sau restart. Chốt SLO sau khi có số đo và phần cứng mục tiêu.

### Giai đoạn C — Chất lượng câu trả lời và dữ liệu

- [ ] Mở rộng golden dataset cho câu hỏi nghiệp vụ, follow-up, thay đổi chủ đề, nguồn được chọn, biểu đồ và xuất file.
- [ ] Đưa Local Harness/Memory/Training evaluation vào CI; phân biệt lỗi retrieval, SQL, tool execution và synthesis.
- [ ] Đánh giá Recall@K/MRR và citation correctness; benchmark reranker so với baseline RRF.
- [ ] BE-07: corpus SQL có CTE/subquery, identifiers đặc biệt, truy vấn lớn và câu không được phép.
- [ ] Theo dõi token/cost/retry theo provider, chỉ bật fallback theo chính sách dữ liệu và cấu hình đã duyệt.

Đầu ra nghiệm thu: regression suite theo case thật đã ẩn danh, không giảm chất lượng baseline; kết quả evaluation có cấu hình/model/dataset version để so sánh.

### Giai đoạn D — Mở rộng có kiểm soát

- [ ] BE-08: repository interface → PostgreSQL migration có rollback; Redis/BullMQ cho ingestion và DLQ nếu tải thực tế cần.
- [ ] Tách parser/embedding worker, resource limits, version tài liệu và reconciliation metadata/file/vector.
- [ ] BE-11: chia domain routes và chuẩn hóa adapter/tool contract.
- [ ] MCP thật: transport, discovery, timeout, allowlist công cụ và quyền thực thi; không nâng nhãn prototype trước khi có integration test.
- [ ] Persistent graph/OCR/cloud sync sau khi nền tảng quyền và ingestion đã đạt nghiệm thu.

Phụ thuộc: A → B; C có thể bắt đầu với fixture cô lập trong khi hoàn thiện B; D phụ thuộc migration/backup và các phép đo của B. Chưa ấn định lịch vì chưa xác định nhân lực, SLA và môi trường triển khai.

## 5. Kiểm chứng trong lần rà soát

- `npm test`: **95 pass, 0 fail**, ngày 08/09/2026.
- Đã đọc entrypoint, router, auth, provider manager, storage, core exports và scripts/tests liên quan.
- Chưa gọi SQL Server, Qdrant, embedding hoặc cloud LLM để kiểm thử end-to-end; chưa chạy load test, penetration test hay dependency audit.
- Không đọc nội dung secret runtime để đưa vào báo cáo; không sửa logic backend trong nhiệm vụ viết tài liệu.

Lệnh đánh giá có sẵn trong [package.json](../package.json): `npm test`, `npm run eval:retrieval`, `npm run eval:local`, `npm run training:collect`, `npm run training:evaluate`. Các lệnh evaluation/collection cần xem script và chuẩn bị dữ liệu riêng trước khi chạy vì có thể gọi dịch vụ hoặc sinh dữ liệu đánh giá.

## 6. Cách theo dõi backlog

Mỗi BE-ID khi triển khai cần ghi: người phụ trách, bằng chứng tái hiện, commit sửa, test chứng minh, ảnh hưởng tương thích/migration và trạng thái Open/In progress/Verified. Chỉ chuyển Verified khi tiêu chí nghiệm thu tương ứng đã chạy đạt; không đánh dấu hoàn tất chỉ vì đã viết kế hoạch.
