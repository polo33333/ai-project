# KnowledgeHub AI

KnowledgeHub AI là nền tảng tri thức self-hosted đang được phát triển bằng Node.js và Vanilla HTML/CSS/JavaScript. Phiên bản hiện tại tập trung vào quản lý tri thức từ SQL Server, Data Dictionary, Business Glossary, Text-to-SQL, chat đa nhà cung cấp AI và các công cụ phân tích dữ liệu.

> **Trạng thái:** MVP đang phát triển. Runtime dữ liệu ứng dụng đã chuyển sang PostgreSQL, gồm auth, cấu hình, chat/memory/audit và metadata tài liệu. Ingest/delete tài liệu có outbox PostgreSQL, retry và worker lease; chưa triển khai Redis/BullMQ hoặc parser service riêng. Xem [Trạng thái triển khai](#trạng-thái-triển-khai).

README đối chiếu tổng thể với mã nguồn ngày **26/10/2026** (phần hiệu suất tải tab đo ngày 22/10/2026). Trạng thái dưới đây mô tả chức năng đã triển khai; kết nối SQL, model, Qdrant và MCP thực tế phụ thuộc cấu hình của từng máy.

## Tính năng hiện có

### SQL Knowledge Connector

- Nạp schema từ file DDL hoặc kết nối trực tiếp Microsoft SQL Server.
- Đọc table, column, primary key và metadata schema.
- Quản lý Data Dictionary, quan hệ bảng và Business Glossary. Quan hệ hỗ trợ vai trò, cột hiển thị, trạng thái xác minh và xóa trực tiếp trên UI.
- Join planner dùng quan hệ đã cấu hình để làm giàu kết quả: ưu tiên cột hiển thị đã map, dùng vai trò làm tiêu đề và giảm ưu tiên các cột ID thô.
- Đồng bộ schema, relationship và glossary sang Qdrant.
- Text-to-SQL với giới hạn câu lệnh `SELECT/WITH` và `TOP 100` mặc định.
- Thực thi truy vấn read-only, hiển thị bảng kết quả, biểu đồ và xuất dữ liệu.

### AI và chat

- Mọi provider (local và cloud) chạy qua một harness có quản trị (`guarded_agent_harness`): với `HARNESS_PIPELINE=v2`, câu hỏi đi qua luồng hợp đồng v2 trước (dữ liệu, quy trình, tài liệu, trò chuyện — xem [Harness dữ liệu v2](#harness-dữ-liệu-v2-và-khi-đổi-nguồn-sql)); câu v2 chưa xử lý được chuyển sang vòng agent gọi công cụ.
- Adapter cho Ollama, OpenAI-compatible, Google Gemini và Anthropic.
- Quản lý AI Provider: thêm, sửa, xóa, kích hoạt, lấy danh sách model và kiểm tra kết nối.
- Persona, lịch sử hội thoại, audit log và model selector.
- Công cụ tích hợp: kiểm tra/sửa/thực thi SQL, tìm schema/glossary/tài liệu, tính toán, biểu đồ và export.
- Guarded harness (`AI_PROVIDER_GUARDS_ENABLED=true`): kiểm tra tham số tool/SQL/kết quả, repair có giới hạn, context budget và deadline. Page chat, modal và embed dùng chung luồng backend. Local Model Harness và bộ định tuyến TEV1 riêng đã được gỡ.
- Gate `SUCCESS/PARTIAL`: PARTIAL có thể hiển thị kèm trạng thái nhưng không vào memory thành công hoặc history SUCCESS gửi cho lượt tiếp theo. Memory do ứng dụng quản lý, không giao provider tự quyết định ghi nhớ.
- Lịch sử giao diện page chat lưu riêng trong PostgreSQL theo account, có version chống ghi đè giữa thiết bị; localStorage chỉ giữ tùy chọn và ID phiên đang mở. Nhập lịch sử trình duyệt cũ cần xác nhận quyền sở hữu.
- Che đường dẫn hệ thống trong câu trả lời của page/modal/embed; giữ link tải hợp lệ qua `/api/exports/...`.
- `skill_core`: registry và editor skill (tab Skills), dùng trong catalog quy trình; luồng chat không còn gọi skill/few-shot từ đây sau khi gỡ Local Model Harness. Ví dụ hợp đồng đã duyệt cho v2 đến từ vòng học phản hồi (`npm run learn:build` / `learn:approve`).
- Request budget dùng chung cho model call, SQL attempt và deadline; truyền abort signal xuống SQL connector.
- Memory Core: phân loại follow-up/chủ đề, lưu references và kiểm tra chất lượng trước khi ghi nhớ hội thoại.
- Streaming tiến trình qua `/api/intelligent-core/chat/stream`, gồm sự kiện tiến trình và kết quả cuối; không đồng nghĩa streaming token đầy đủ.
- Training Core: thu thập case, đánh giá SQL/câu trả lời, phân loại lỗi và tạo đề xuất cải tiến; chưa phải hệ thống fine-tuning model.
- Workflow phase 1: catalog/plugin có phiên bản, template/slot, fixture/publish, run checkpoint/resume/cancel và file tải theo owner. Tab Quy trình tự động đã mở; tính năng mặc định tắt.
- Tệp đính kèm trong chat (PDF/DOCX/XLSX/CSV/TXT/MD và ảnh PNG/JPG/WEBP): ảnh và PDF quét được chép thành chữ bằng mô hình đọc được ảnh (Gemini hoặc Ollama có vision); nội dung chỉ dùng trong cuộc trò chuyện đó, không vào thư viện tài liệu. Bật bằng `CHAT_ATTACHMENT_PROCESSING_ENABLED`.
- Training Core có tab Skills để sửa hướng dẫn, bật/tắt skill và chọn ví dụ; cấu hình lưu PostgreSQL khi dùng backend `postgres`.
- Memory Core v2 có pending turn, context budget và summary (cấu hình mẫu bật cả ba). Cờ `MEMORY_SEMANTIC_ROUTING_ENABLED` vẫn hiện trong Cài đặt nhưng không còn mã chạy dùng tới.

### Quy trình tự động và định tuyến chat

- Không còn bộ định tuyến riêng: TEV1 và `CHAT_ROUTING_MODE` đã gỡ; chỉ mục `workflow_routing_v1` không còn được dùng (backup vẫn sao kèm collection này). Bộ điều phối có quản trị (`governance/controller.js`) đưa quy trình được phép vào cùng lần gọi lập hợp đồng v2 (mục `WORKFLOWS`); vòng agent dùng công cụ `list_workflows`/`run_workflow`. Backend vẫn kiểm tra quyền, input và trích dẫn từ câu hỏi trước khi chạy.
- Tab **Quy trình tự động** quản lý catalog/plugin có phiên bản, mẫu câu hỏi và slot đầu vào; hỗ trợ sửa draft, validate, chạy fixture, publish, bật/tắt và rollback. Mẫu tham khảo tra cứu hợp đồng, nhân viên và báo cáo điện ở `docs/templates/` cần cấu hình nguồn thực tế.
- Workflow đọc SQL có parameter, gọi API, đọc file Thư viện hoặc kế thừa kết quả bước trước; hỗ trợ mapping cột, transform/condition/assert/collect/delay, biểu đồ và export CSV/XLSX. API có thể ghi dữ liệu; tác vụ ghi bị gián đoạn chuyển `NEEDS_REVIEW`, không tự retry.
- Run có owner, revision, checkpoint, thu thập input, resume/cancel và artifact có hạn tải. Chat chính và embed hỗ trợ form nghiệp vụ, bảng/biểu đồ và kết quả; embed không hiển thị Thinking/timeline xử lý.
- `WORKFLOW_PLUGINS_ENABLED=false` trong cấu hình máy chủ chặn bật workflow từ UI. Để dùng, áp dụng migration (`npm run db:migrate`), đổi flag thành `true`, khởi động lại, cấu hình nguồn rồi validate/test/publish mẫu. Soạn quy trình qua MCP: [WORKFLOW_AUTHORING_MCP.md](docs/WORKFLOW_AUTHORING_MCP.md), [WORKFLOW_HOSTED_MCP.md](docs/WORKFLOW_HOSTED_MCP.md).

Model trả lời được ghim đầu request. Hỏi bổ sung khi thiếu input, giữ run đang chờ khi người dùng chuyển chủ đề; các bước dùng chung ngân sách lần gọi model và deadline.

### Hỏi đáp tài liệu (RAG) — cập nhật 26/10/2026

Một dịch vụ RAG dùng chung (`src/backend/knowledge_core/rag/`) cho đường v2, công cụ `search_knowledge_base` của vòng agent và tài liệu nguồn chọn trong khung chat:

1. **Hiểu câu hỏi** (`query.js`, không gọi model): bỏ tiền tố lệnh ("kho tri thức:", "tìm trong…"); tên tệp trong câu → chỉ tìm trong tài liệu đó; câu hỏi tiếp ("còn…", "phần … thì sao", "tài liệu trên…") → tìm trong tài liệu của câu trả lời trước. v2 còn nhận `documentQuery` do model viết lại trong cùng lần lập hợp đồng.
2. **Truy hồi**: BGE-M3/Qdrant + BM25 (giữ cả chữ số đơn), gộp RRF; bỏ đoạn chỉ có tiêu đề và đoạn trùng; lọc theo quyền đọc và phiên bản. Mất Qdrant/embedding thì chuyển sang chỉ từ khóa và ghi chế độ `lexical_degraded`. GraphRAG (quy tắc từ khóa) **mặc định tắt** vì làm giảm thứ hạng trên bộ đo.
3. **Đóng gói**: ngân sách `AI_DOCUMENT_CONTEXT_TOKENS` chung cho mọi đường; đoạn ngắn được ghép đoạn kề cùng mục.
4. **Trả lời**: bắt buộc trích dẫn `[n]`; trích dẫn gộp kiểu `[1, 3]` được tách thành `[1][3]`.
5. **Kiểm chứng** (`verify.js`): số, ngày, mã, liên kết trong câu có trích dẫn phải có trong đoạn được trích; hiện chỉ ghi nhận (`citationValidation.unsupportedClaims`), chưa chặn câu trả lời.

**Định tuyến tài liệu / dữ liệu / trò chuyện** (`signal.js`): một tín hiệu tài liệu tất định (một lần nhúng trên máy) — mạnh khi câu có tên tệp, có cụm "theo tài liệu / kho tri thức", hoặc điểm khớp ≥ `RAG_ROUTING_MIN_SCORE` (mặc định 0,6). Bộ lọc từ khóa xếp câu vào trò chuyện mà tín hiệu mạnh → trả lời từ tài liệu, không qua bước lập hợp đồng; model chọn `chat` mà tín hiệu mạnh → trả lời từ tài liệu; model chọn `data` thì **không bao giờ** bị đổi. Lời nhắc lập hợp đồng có mục `LIBRARY` (tên và một dòng mô tả các tài liệu model được phép nhận).

**Quyền gửi tài liệu cho model**: mỗi tài liệu có `governedPolicy` (độ nhạy, model được nhận). Tài liệu không được gửi cho model đang dùng thì nội dung không rời máy; nếu đó là tài liệu khớp nhất, người dùng nhận thông báo "tài liệu có nhưng chưa được phép gửi cho mô hình này" (không gọi model, trạng thái `DOCUMENT_NOT_PERMITTED`; tài liệu `restricted` không bị nêu tên).

**Nạp tài liệu**: bộ cắt đoạn `structured-v2` — PDF ghép các mảnh chữ bị tách quanh ký tự có dấu, tiêu đề không có nội dung được gộp vào đoạn sau. Thay chỉ mục theo thế hệ: ghi bản mới rồi mới xóa bản cũ. Đổi bộ cắt đoạn cần lập chỉ mục lại (`library.reindexAll()` xếp hàng `document.ingest`, máy chủ đang chạy xử lý). PDF scan vẫn cần OCR; ảnh trong tệp Word chưa được đọc.

Đo: `npm run eval:retrieval` (recall@k/MRR theo chế độ, `--rechunk` mô phỏng lập chỉ mục lại) và `npm run eval:routing` (đường đi của câu hỏi, quét ngưỡng). Số liệu và kế hoạch: [docs/RAG_REVIEW_261026.html](docs/RAG_REVIEW_261026.html).

### API và quản trị

- Giao diện dashboard bằng HTML/CSS/JavaScript thuần, không có build step frontend.
- Session authentication và tài khoản có role.
- Menu Tài khoản có đổi mật khẩu: xác minh mật khẩu hiện tại, băm scrypt, thu hồi mọi phiên của account và yêu cầu đăng nhập lại. Trang đăng nhập không hiển thị mật khẩu mặc định.
- API key nội bộ, embed-chat configuration và endpoint OpenAI-compatible cơ bản.
- System logs, chat audit, analytics và system tools. Lịch sử chat có cột nguồn (Page Chat, Embed Chat, API); log xử lý chat được lọc khỏi System Logs.
- Library hỗ trợ upload, parse PDF/DOCX/XLSX/CSV/TXT/SQL/Markdown, chunk, index, preview và xóa tài liệu.
- Watch Folder theo dõi filesystem thật, quét file ban đầu, chống trùng bằng `sourcePath` + SHA-256 và cập nhật lại document khi file đổi.
- UI Chat hiển thị mode retrieval, RRF/reranker, số chunk và nguồn tài liệu.
- Câu trả lời theo tài liệu có marker `[1]`, `[2]` dùng chung cho mọi provider. Khối “Đoạn nguồn theo trích dẫn” mặc định thu gọn và cho phép mở đoạn nguồn để đối chiếu. Kiểm tra số/ngày/mã trong câu so với đoạn được trích đang ở chế độ ghi nhận, chưa phải xác minh ngữ nghĩa toàn bộ câu trả lời.
- Quyền theo từng tài liệu (`governedPolicy`): ai được đọc, độ nhạy và model nào được nhận nội dung.
- Dashboard và trang Analytics hiển thị trạng thái chờ trong khi tải dữ liệu biểu đồ, gồm tần suất gọi AI, đánh giá, bản đồ nhiệt và tỷ trọng provider.
- MCP client kết nối server qua stdio, Streamable HTTP hoặc SSE; có handshake, discovery tools/resources và thực thi tool qua Agent Core/registry.
- Embed Chat hiển thị bảng Markdown, biểu đồ, link xuất file; hỗ trợ `data-theme="auto|light|dark"` và preview theo Embed ID từ trang quản trị.

### Hiệu suất tải tab — cập nhật 22/10/2026

- Tổng quan và Analytics dùng dữ liệu thống kê rút gọn, tái sử dụng bộ định dạng ngày theo múi giờ Việt Nam; giữ nguyên số token và cách tính giá trị ước tính, kể cả nội dung có emoji.
- Quản trị dữ liệu tải báo cáo vận hành song song với cấu hình tài nguyên/chỉ tiêu. Báo cáo chỉ đọc các trường cần cho trạng thái, độ trễ, tiêu chí, mức sử dụng và chi phí.
- Lịch sử chat tải danh sách nhẹ; chọn **Xem JSON** để tải đầy đủ chẩn đoán và tool execution của riêng lượt đó. API chi tiết kiểm tra quyền sở hữu như danh sách.
- Đánh giá AI chỉ tải nội dung cần cho tìm kiếm, xem câu trả lời/SQL, token và kiểm duyệt. Đào tạo AI chỉ nạp chi tiết các lượt được đánh dấu `needs_review`, giữ nguyên logic tạo báo cáo.
- Bộ nhớ AI, xác thực Embed trong tab Tài khoản và danh sách/trạng thái sao lưu chỉ đọc các kho liên quan. Nguồn SQL không còn gọi thêm API lược đồ chỉ để cập nhật thẻ thống kê của Tổng quan.
- Các truy vấn rút gọn không bỏ kiểm tra đăng nhập/phân quyền. API audit đầy đủ vẫn được giữ để tương thích; không dùng cache dùng chung cho lịch sử riêng của tài khoản.

Kết quả đo cục bộ với **2.502 lượt chat**; đây là thời gian xử lý/đọc dữ liệu, không phải cam kết thời gian tải toàn trang qua mạng:

| Phần dữ liệu | Trước | Sau |
|---|---|---|
| Dữ liệu lịch sử cho Tổng quan | khoảng 12,9 MB / 1,38 giây | khoảng 735 KB / 0,19 giây |
| Danh sách Lịch sử chat | khoảng 12,9 MB / 1,40 giây | khoảng 1,07 MB / 0,15 giây |
| Báo cáo vận hành | khoảng 1,40 giây | khoảng 0,39 giây |

Đã đối chiếu số liệu thống kê, nội dung audit chi tiết và báo cáo đào tạo trước/sau trên dữ liệu hiện tại. Có thể chạy lại phép đo chỉ đọc trên instance PostgreSQL đã cấu hình:

```powershell
node scripts/audit_tab_performance.js
```

Script ghi thời gian, kích thước và kết quả đối chiếu vào `artifacts/tab-performance/audit.json`, không ghi nội dung câu hỏi hay kết quả nghiệp vụ trong báo cáo. Sau khi cập nhật mã, khởi động lại backend và tải lại trang bằng **Ctrl + F5**. Không cần migration CSDL cho đợt tối ưu này.

## Trạng thái triển khai

| Khu vực | Trạng thái | Ghi chú |
|---|---|---|
| Vanilla web dashboard | Khả dụng | Phục vụ trực tiếp từ Node.js |
| SQL Server Connector | Khả dụng | Hỗ trợ DDL và live connection |
| Data Dictionary/Glossary | Khả dụng | Có lưu trữ và đồng bộ Qdrant |
| Text-to-SQL | Khả dụng có giới hạn | Cần dùng SQL account read-only ở môi trường thật |
| AI Provider adapters | Khả dụng | Luồng chat ghim provider/model đầu request; không tự chuyển provider khi lỗi |
| Intelligent Core/tools | Khả dụng | Guarded harness cho mọi provider; luồng hợp đồng v2 trước, vòng agent gọi công cụ làm dự phòng |
| Harness dữ liệu v2 | Đã triển khai (`HARNESS_PIPELINE=v2`) | Một lần gọi model lập hợp đồng; SQL do code biên dịch; chỉ tiêu nghiệp vụ đã duyệt (`npm run metrics:seed`) và ví dụ hợp đồng học từ phản hồi |
| Qdrant schema search | Khả dụng khi có Qdrant/BGE-M3 | Collection schema v2 dùng embedding thật 1024 chiều; fallback deterministic mặc định tắt |
| Dictionary identity | Đã triển khai | Phân biệt nguồn kết nối, database, schema, table và column; backup migration nằm trong `data/backup/` |
| Skill registry | Còn trong tab Skills/catalog quy trình | Local Model Harness đã gỡ nên luồng chat không còn dùng skill/few-shot |
| Semantic SQL eval | Runner offline khả dụng | Logic chấm điểm ở `scripts/eval/`; corpus hiện có 12 case, live baseline phụ thuộc data source eval phù hợp |
| Library | Khả dụng ở mức MVP | Upload/parse/chunk/index thật; bộ cắt đoạn `structured-v2`; chống upload trùng nội dung bằng SHA-256; quyền đọc/gửi model theo từng tài liệu; chưa có OCR |
| Watch Folder | Khả dụng ở mức MVP | Theo dõi filesystem, debounce, retry và cập nhật idempotent theo file nguồn |
| MCP Sources | Đã triển khai kết nối thật | SDK MCP, handshake/discovery/execution; cần khai báo server riêng, test stdio không chứng minh mọi server bên ngoài tương thích |
| Embed Chat | Đã triển khai | Endpoint JSON, domain allowlist, giới hạn theo cấu hình; admin preview bỏ kiểm tra domain |
| Skill editor | Đã triển khai | Sửa hướng dẫn và ví dụ trên UI; hiệu lực xử lý phụ thuộc feature flag |
| Memory Core v2 | Triển khai theo feature flag | Cấu hình mẫu bật pending turn, context budget và summary |
| Workflow Automation | Đã triển khai, mặc định tắt | Editor mẫu, SQL/API/file/bước trước, mapping, biểu đồ/export và checkpoint; cần cấu hình nguồn và publish |
| Chat/workflow routing | Đã triển khai | Bộ điều phối có quản trị; quy trình chọn trong hợp đồng v2 hoặc qua công cụ; TEV1 đã gỡ |
| Định tuyến tài liệu/dữ liệu/trò chuyện | Đã triển khai | Tín hiệu tài liệu + mục `LIBRARY`; đo bằng `npm run eval:routing` (bộ câu nháp) |
| Web search | Đã triển khai | Endpoint cấu hình qua `WEB_SEARCH_ENDPOINT`; phụ thuộc mạng và chất lượng nguồn |
| HTTPS/PWA | Đã triển khai | Certificate PEM, manifest và service worker frontend |
| PostgreSQL app storage | Đã cutover | Schema `app`, migration 001–009; hỗ trợ nhập/đối soát JSON khi cutover, runtime không tự fallback về JSON |
| Document outbox | Đã triển khai | PostgreSQL jobs, retry, lease và recovery; tác động file/Qdrant vẫn cần reconciliation |
| Redis/BullMQ | Chưa triển khai | Outbox hiện chạy trong Node.js, chưa có worker service riêng |
| Page chat history | Đã triển khai | Bảng `app.ui_chat_sessions`, owner account, mã hóa và kiểm tra version |
| Tải dữ liệu theo tab | Đã tối ưu | View được tải lười theo tab; request đang chạy được dùng chung; dữ liệu tab có cache ngắn hạn và tự tải lại khi hết hạn; thao tác thay đổi dữ liệu cập nhật trực tiếp |
| Document RAG | Đã triển khai, phụ thuộc dịch vụ | Dịch vụ `knowledge_core/rag` dùng chung; BGE-M3 + BM25 + RRF; khi mất vector ghi `lexical_degraded`. Bộ đo nháp 26/10: recall@5 100%, MRR 94,6% |
| BGE Reranker | Sẵn sàng tích hợp, chưa đo | Bật bằng `RERANKER_ENABLED=true` khi reranker HTTP hoạt động |
| GraphRAG | Mặc định tắt | Quy tắc từ khóa; làm giảm thứ hạng trên bộ đo; chưa có knowledge graph lưu trữ |

## Yêu cầu hệ thống

- **Node.js 22 trở lên** — dùng Fetch API và `node:util.parseEnv`.
- npm.
- Docker Desktop trên Windows, chế độ Linux containers, cho PostgreSQL 18; hoặc PostgreSQL bên ngoài được cấu hình tương ứng.
- Microsoft SQL Server nếu sử dụng live SQL Connector.
- Qdrant tại `http://127.0.0.1:6333` nếu sử dụng vector schema/document search.
- BGE-M3 qua Ollama hoặc endpoint OpenAI-compatible nếu sử dụng dense retrieval.
- HTTP reranker service tương thích endpoint `/rerank` nếu bật BGE Reranker.
- Một trong các AI runtime/provider:
  - Ollama tại `http://localhost:11434`;
  - LM Studio/OpenAI-compatible endpoint;
  - Google Gemini;
  - Anthropic;
  - OpenAI hoặc provider tương thích OpenAI Chat Completions.

## Cài đặt và chạy

### 1. Clone và cài dependency

```powershell
git clone <repository-url>
cd ai-project
npm install
```

Nếu source được nhận dưới dạng archive, giải nén rồi chạy `npm install` trong thư mục chứa `package.json`.

### 2. Tạo cấu hình môi trường

PowerShell:

```powershell
Copy-Item .env.example .env
```

Các biến đang được hỗ trợ:

```dotenv
# HTTP server
PORT=3000
HOST=127.0.0.1
BOOTSTRAP_ADMIN_PASSWORD=replace-with-your-password
CORS_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000

# Qdrant
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=database_schema_v2
QDRANT_VECTOR_SIZE=1024
QDRANT_DOCUMENT_COLLECTION=knowledge_documents_bge_m3_v1
QDRANT_DOCUMENT_VECTOR_SIZE=1024

# Document embedding: mẫu để false (chỉ tìm từ khóa, không cần Qdrant/embedding); đặt true khi có Qdrant + BGE-M3
EMBEDDING_ENABLED=false
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_FALLBACK_MODE=error

# Hybrid retrieval
RETRIEVAL_CANDIDATE_LIMIT=30
RRF_K=60
AI_DOCUMENT_CONTEXT_TOKENS=3000

# Optional reranker and graph retrieval
RERANKER_ENABLED=false
RERANKER_BASE_URL=http://127.0.0.1:8081
RERANKER_MODEL=bge-reranker-v2-m3
GRAPHRAG_ENABLED=false
# Điểm khớp từ đó câu hỏi được coi là hỏi tài liệu (chọn bằng npm run eval:routing)
RAG_ROUTING_MIN_SCORE=0.6

# Bật đúng một lần sau khi đổi model/collection, rồi chuyển lại false
KNOWLEDGE_REINDEX_ON_START=false

# Intelligent Core
AI_DEFAULT_TIMEOUT_MS=30000
LOCAL_MODEL_MAX_MODEL_CALLS=12
LOCAL_MODEL_MAX_SQL_CALLS=3
AI_PROVIDER_GUARDS_ENABLED=true
AI_PROVIDER_MAX_REPAIRS=2
# v2 = luồng hợp đồng trước (xem "Harness dữ liệu v2"); bỏ trống = chỉ vòng agent
HARNESS_PIPELINE=v2
CHAT_ANSWER_STREAMING_ENABLED=true
CHAT_ATTACHMENT_PROCESSING_ENABLED=true

# SQL relationship và join enrichment
SQL_RELATIONSHIP_DISCOVERY_ENABLED=false
SQL_JOIN_PLANNER_ENABLED=false

# System log retention (the selected storage backend applies)
MAX_CHAT_HISTORY=5000

# Memory Core v2
MEMORY_PENDING_TURN_ENABLED=true
MEMORY_CONTEXT_BUDGET_ENABLED=true
MEMORY_SUMMARY_ENABLED=true
# Hạn mức phiên áp theo từng tài khoản trước, tổng hệ thống chỉ là chặn dự phòng
AI_MEMORY_MAX_SESSIONS_PER_ACCOUNT=200
AI_MEMORY_MAX_SESSIONS=5000
# Nhật ký lượt (mọi lượt kể cả PARTIAL, hợp đồng v2, 20 dòng kết quả đầu) dùng cho hỏi nối tiếp/tham chiếu dòng
AI_MEMORY_MAX_TURNS=20

# Workflow
WORKFLOW_PLUGINS_ENABLED=false
WORKFLOW_API_ALLOWED_ORIGINS=

# App storage (credentials và khóa riêng tạo bởi db:pg:init)
APP_STORAGE_BACKEND=postgres
APP_PG_HOST=127.0.0.1
APP_PG_PORT=5432
APP_PG_DATABASE=knowledgehub_app

# MCP
MCP_CONNECT_TIMEOUT_MS=15000
MCP_CALL_TIMEOUT_MS=30000
```

Danh sách cấu hình đầy đủ và mặc định nằm trong [.env.example](.env.example). `BOOTSTRAP_ADMIN_PASSWORD` chỉ tạo admin trong bước bootstrap JSON khi chưa có account, không đổi mật khẩu account đã tồn tại. Runtime PostgreSQL yêu cầu account đã được nhập và database ở trạng thái `live`.

Không lưu API key, password hoặc connection string thật vào Git. Provider được quản lý qua giao diện và lưu PostgreSQL; credential được mã hóa. Xem [Cảnh báo bảo mật](#cảnh-báo-bảo-mật).

### 3. Khởi động dịch vụ phụ trợ

#### PostgreSQL

Với môi trường đã cutover, giữ nguyên `.env.postgres`, khóa mã hóa và Docker volume. Chạy `npm start` sẽ kiểm tra/bật Docker và container PostgreSQL cục bộ, chờ `pg_isready` trước backend. Không chạy lại init/import/cutover vào database live.

Với cài đặt mới hoặc chuyển từ dữ liệu JSON, tạo `.env.postgres` đã ignore khỏi Git:

```dotenv
POSTGRES_DB=knowledgehub_app
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<mat-khau-rieng-cua-ban>
```

Khởi động Docker Desktop, dừng backend/writer JSON và chạy:

```powershell
docker compose --env-file .env.postgres -f compose.docker.yml up -d postgres
# Chờ container healthy trước bước init
npm run db:pg:init
npm run db:migrate
npm run data:pg:cutover
```

`db:pg:init` tạo role migrator/runtime và file khóa riêng; chỉ chạy khi chưa có các role/credential này. `data:pg:cutover` backup, lấy snapshot cuối, nhập/đối soát hoặc hợp nhất delta staging, chuyển database sang live và chọn PostgreSQL trong cấu hình. Cần sẵn dữ liệu account JSON. Nếu cài hoàn toàn mới, đặt mật khẩu bootstrap riêng trong `.env`, rồi tạo account trước cutover bằng chế độ JSON tường minh:

```powershell
$env:APP_STORAGE_BACKEND='json'
node -e "require('./src/backend/services/auth_service')"
Remove-Item Env:APP_STORAGE_BACKEND
```

Không dùng lệnh bootstrap JSON này với môi trường đã cutover. Schema ứng dụng là `app`, không phải `public`; trong pgAdmin mở `knowledgehub_app → Schemas → app → Tables`. Audit chat ở `chat_runs`, memory ở `chat_sessions/chat_messages`, lịch sử giao diện ở `ui_chat_sessions` (payload mã hóa).

#### Qdrant và model

Qdrant là tùy chọn cho chat chung nhưng cần cho dense search và đồng bộ vector. Ví dụ chạy Qdrant bằng Docker:

```powershell
docker run --name knowledgehub-qdrant -p 6333:6333 -p 6334:6334 -v knowledgehub_qdrant:/qdrant/storage qdrant/qdrant
```

Nếu dùng Ollama cho embedding, khởi động Ollama và tải `bge-m3`. LLM Chat là model/provider riêng; BGE-M3 không sinh câu trả lời. BM25 và RRF không cần model. Reranker là dịch vụ tùy chọn và không dùng endpoint embedding của Ollama trong triển khai hiện tại.

### 4. Chạy KnowledgeHub

```powershell
npm start
```

Nếu đã tự khởi động các dịch vụ phụ trợ, có thể chạy trực tiếp bằng `npm run dev` hoặc `node server.js`; cách này không gọi launcher kiểm tra Docker/Ollama/Qdrant.

Trên Windows và macOS, `npm start` gọi `scripts/start.js` và tự động:

1. Đọc `.env` và `.env.postgres`, giữ ưu tiên biến môi trường đã có.
2. Khi backend là PostgreSQL cục bộ: dùng dịch vụ đang chạy nếu kết nối được; nếu chưa có thì kiểm tra Docker, mở Docker Desktop, bật hoặc tạo container từ `compose.docker.yml` và chờ database sẵn sàng. PostgreSQL remote bỏ bước Docker cục bộ. Bước này không tự chạy migration/import.
3. Kiểm tra/bật container `knowledgehub-qdrant` (Qdrant 1.18.3), tạo qua Compose stack `ai-project` nếu chưa có, và chờ API sẵn sàng. Không dùng `QDRANT_EXE`; Qdrant remote chỉ kiểm tra API.
4. Nếu `EMBEDDING_PROVIDER=ollama`, kiểm tra API Ollama và các model được cấu hình. Thiếu Ollama hoặc model chỉ tạo cảnh báo, không chặn ứng dụng khởi động và không tự tải model.
5. Chạy KnowledgeHub qua supervisor. `[Startup] Completed.` chỉ in sau HTTP listen thành công.

Ollama là tùy chọn ở bước khởi động; các chức năng cần embedding/model sẽ báo lỗi khi được dùng nếu dịch vụ chưa sẵn sàng. Trên Mac mini cần Node.js và Docker Desktop khi dùng PostgreSQL/Qdrant cục bộ; `.env.postgres` cùng file khóa mã hóa phải có đường dẫn hợp lệ trên macOS. `scripts/start-local.ps1` vẫn là script Windows cũ, không còn được gọi bởi `npm start`.

Mở:

- Dashboard trên máy chạy server: `http://localhost:<PORT>/`
- Đăng nhập trên máy chạy server: `http://localhost:<PORT>/login.html`

Để mở ứng dụng từ máy khác trong cùng mạng LAN, đặt `HOST=0.0.0.0` và `PORT=5500` trong `.env` **trên máy chạy server**, khởi động lại bằng `npm start`, rồi truy cập `http://<IP-của-máy-chạy-server>:5500`. `0.0.0.0` là địa chỉ lắng nghe, không dùng làm địa chỉ truy cập trong trình duyệt. Nếu Mac mini vẫn không nhận kết nối, kiểm tra Firewall của macOS có cho phép kết nối đến Node.js và hai máy có thể liên lạc trong cùng mạng. Các URL `localhost` ở trên chỉ dùng khi truy cập ngay trên máy chạy server.

Để bật HTTPS trực tiếp, đặt `HTTPS_CERT_FILE` và `HTTPS_KEY_FILE` trong `.env` tới certificate và private key dạng PEM rồi khởi động lại. Ví dụ trên Mac: `HTTPS_CERT_FILE=/Users/kdone/certs/server.crt` và `HTTPS_KEY_FILE=/Users/kdone/certs/server.key`. Khi đó truy cập `https://<IP-hoặc-tên-máy>:5500`; cổng này chỉ nhận HTTPS. Certificate phải hợp lệ với IP hoặc tên máy dùng trên trình duyệt; certificate tự ký sẽ cần được tin cậy trên máy khách. Không lưu private key vào Git. Nếu dùng reverse proxy xử lý TLS, để trống hai biến này và giữ backend ở HTTP.

Tài khoản khởi tạo lần đầu:

```text
Username: admin
Password: giá trị BOOTSTRAP_ADMIN_PASSWORD đã đặt trong .env
```

Nếu chưa có tài khoản và thiếu biến này, backend dừng với thông báo yêu cầu cấu hình. Supervisor hỗ trợ yêu cầu khởi động lại từ Settings; không tự restart khi server thoát bất ngờ.

## Thiết lập nhanh

Sau khi đăng nhập:

1. Mở **AI Providers**.
2. Thêm hoặc cập nhật local/cloud provider.
3. Bấm kiểm tra kết nối và kích hoạt provider muốn dùng.
4. Nếu cần Text-to-SQL, mở **SQL Connector** và nạp DDL hoặc thêm live connection.
5. Mở **Data Dictionary** để kiểm tra schema, mô tả cột và trạng thái active.
6. Bổ sung thuật ngữ tại **Business Glossary**.
7. Đồng bộ dữ liệu schema sang Qdrant.
8. Khởi động BGE-M3 và bật reindex một lần nếu cần dense retrieval cho tài liệu.
9. Upload tài liệu hoặc cấu hình **Watch Folder**; kiểm tra nhãn `Hybrid sẵn sàng`/`Chỉ BM25`.
10. Sử dụng **AI Chat** hoặc **Text-to-SQL** để truy vấn.

Với live SQL Server, nên tạo tài khoản database riêng chỉ có quyền `SELECT` trên đúng schema cần thiết. Guard trong ứng dụng không thay thế quyền read-only ở cấp database.

Khi nâng dictionary cũ sang identity v1, chạy:

```powershell
npm run migrate:dictionary-identity
```

Script tạo bản sao trước migration trong `data/backup/`. Sau migration, đồng bộ lại schema sang collection `database_schema_v2`. Có thể bật skill và few-shot bằng `.env`; few-shot chỉ hoạt động khi skill cũng bật.

## Kiến trúc hiện tại

### Embed Chat và MCP

Tại **API tích hợp & Embed Chat**, tạo cấu hình rồi sao chép mã nhúng với `data-embed-id` tương ứng. `data-title` đặt tên hiển thị, độc lập với ID/tên cấu hình. `data-theme="auto"` theo `data-theme` trên `<html>`, nếu không có thì theo hệ điều hành; không tự nhận biết mọi quy ước theme của website khác.

Nút **Mở thử** bật preview theo ID đã chọn; nhấn lại ẩn cả khung và nút nổi. Preview của admin đăng nhập bỏ qua domain allowlist, vẫn kiểm tra ID/trạng thái và giới hạn yêu cầu. Widget công khai vẫn kiểm tra domain. Embed dùng `/api/embed/chat`, trả kết quả một lần; Page Chat dùng stream tiến trình. Hai luồng cùng gọi Intelligent Core nhưng khác quyền và giới hạn lịch sử/kết quả.

Tại **Nguồn MCP Server**, thêm endpoint HTTP/SSE hoặc command stdio. Hệ thống thử kết nối, lấy tools/resources và đăng ký tools vào luồng agent; dùng nút **Kết nối** để thử lại khi lỗi. Cấu hình lưu PostgreSQL khi dùng backend `postgres`; `data/mcp_servers.json` thuộc backend JSON/legacy. Đây là MCP client kết nối dịch vụ ngoài, không phải endpoint MCP server do KnowledgeHub tự cung cấp. Khả năng gọi tool còn phụ thuộc model, quyền và trạng thái server.

```text
Browser
  |
  | HTTP + JSON
  v
Node.js HTTP Server
  |-- Static Vanilla HTML/CSS/JS
  |-- Authentication/session
  |-- REST router
  |-- Intelligent Core
  |     |-- Provider adapters
  |     |-- Governed harness
  |     |     |-- Contract pipeline v2 (data / workflow / document / chat)
  |     |     `-- Agent tool loop (fallback)
  |     |-- Tool registry
  |     `-- Document RAG service (knowledge_core/rag)
  |           |-- Question understanding + document signal
  |           |-- BGE-M3 dense search --> Qdrant
  |           |-- BM25 keyword search
  |           |-- RRF fusion, optional BGE reranker
  |           |-- Token-budget packing
  |           `-- Citation + claim check
  |-- Library/Watch Folder ---------> Local files + extracted text
  |-- SQL Server Connector ------> Microsoft SQL Server
  |-- Qdrant Service ------------> Qdrant
  |-- MCP Client ---------------> MCP servers (stdio/HTTP/SSE)
  `-- Async Storage -------------> PostgreSQL app schema + document outbox
```

### Harness dữ liệu v2 và khi đổi nguồn SQL

Bật bằng `HARNESS_PIPELINE=v2` (cần restart). Mã nguồn ở `src/backend/agent_core/pipeline/`. Với câu hỏi dữ liệu, luồng chạy:

1. Lấy schema bằng code (`search_schema`), bổ sung bảng tra cứu nối trực tiếp và bảng của câu hỏi trước.
2. Một lần gọi model để lập **hợp đồng truy vấn**: bảng gốc, cột, phép đo, bộ lọc kèm trích dẫn từ câu hỏi, đầu ra (biểu đồ/xuất file) hoặc workflow phù hợp. Model không viết SQL.
3. Code kiểm tra hợp đồng: mọi mã/ngày/năm trong câu hỏi phải có trong bộ lọc, giá trị lọc phải trích từ câu hỏi, không so chữ với cột ID số. Sai thì model được sửa một lần với lý do cụ thể.
4. Bộ biên dịch sinh T-SQL: JOIN chỉ theo quan hệ nhiều-một đã xác minh (không thể nhân bản dòng), kỳ thời gian là khoảng nửa mở, khóa ngoại hiển thị bằng cột hiển thị theo vai trò. SQL phải qua JOIN validator và bộ kiểm tra bộ lọc dùng chung trước khi chạy.
5. Câu trả lời, biểu đồ và file xuất dựng bằng code từ chính các dòng kết quả. Kết quả rỗng do sai chữ (ví dụ "Phòng Kỹ thuật" so với "Kỹ thuật") được dò lại trong cột; nhiều ứng viên thì hỏi lại người dùng.

Cùng lần gọi lập hợp đồng còn phân loại câu hỏi: `data`, `workflow`/`resume`, `previous` (trả lời từ dòng đã hiển thị), `document` (qua dịch vụ RAG), `chat` hoặc `clarify`. Trước lần gọi này, bộ lọc từ khóa của `search_schema` đẩy câu không giống câu dữ liệu sang trò chuyện — trừ khi tín hiệu tài liệu mạnh thì trả lời từ tài liệu (xem [Hỏi đáp tài liệu](#hỏi-đáp-tài-liệu-rag--cập-nhật-26102026)). Xuất mỗi nhóm một file, hoặc hợp đồng vẫn sai sau một lần sửa sẽ chuyển sang vòng agent (`guarded_agent_harness`).

**Không có tên bảng/cột của một database cụ thể trong code.** Mọi thứ lấy từ Từ điển dữ liệu của nguồn đang chọn; đổi nguồn giữa cuộc chat thì hợp đồng của câu trước không được dùng lại. Chất lượng câu trả lời phụ thuộc metadata. Khi thêm hoặc đổi nguồn SQL:

| Việc cần làm (trong ứng dụng, không sửa code) | Nếu thiếu |
|---|---|
| Thêm nguồn, đồng bộ Từ điển dữ liệu, bật các bảng cần dùng | Không có bảng để trả lời |
| Khai báo và **xác minh quan hệ** khóa ngoại → bảng tra cứu, kèm vai trò và cột hiển thị (kiểm tra dữ liệu trước khi xác minh) | Chỉ trả lời được câu trên một bảng; lọc theo mã khách hàng, tên phòng ban, trạng thái… sẽ không ghép bảng được |
| Đặt **nhãn hiển thị** cho cột quan trọng, nhất là cột tiền/số lượng; ẩn khỏi AI các cột không dùng | Model chọn nhầm cột cùng nghĩa (ví dụ cột tiền toàn giá trị 0) |
| Khai báo mô hình ngữ nghĩa của bảng: thực thể, cột ngày nghiệp vụ, chỉ số mặc định, cột tiền, cột hiển thị trong danh sách | Danh sách thiếu cột ngày/số tiền, chọn sai cột ngày |
| Mã danh mục dùng chung (bảng hằng số/master) phải nối qua đúng khóa ngoại của vai trò đó | Một bảng tra cứu nhiều vai trò sẽ bị báo nhập nhằng |

Giới hạn: chỉ hỗ trợ **SQL Server** (driver `tedious`, bộ biên dịch sinh T-SQL). MySQL/PostgreSQL làm nguồn dữ liệu cần thêm driver và cú pháp.

Đo chất lượng trên model và dữ liệu thật (SQL chỉ đọc, mỗi ca một phiên chat `eval-…`):

```powershell
$env:HARNESS_PIPELINE='v2'; npm run eval:live -- --label v2 --provider <providerId>
$env:HARNESS_PIPELINE='v2'; npm run eval:live -- --label docs --provider <providerId> --only <id1,id2>
```

Bộ câu hỏi và đáp án ở `tests/fixtures/live_eval_cases.json` (74 câu) viết cho dữ liệu IPMS và 4 tài liệu thư viện hiện có; gồm nhóm `document` (10 câu) và `routing` (8 câu). Nguồn khác cần bộ ca và đáp án riêng (đáp án lấy bằng SQL viết tay, không lấy từ câu trả lời của model). Kết quả lưu ở `artifacts/live-eval/`. Mỗi lần chạy gọi model thật và tốn chi phí: chỉ chạy nhóm cần đo. Câu tài liệu trả lời "tài liệu không đề cập" thường là do tài liệu chưa được phép gửi cho model đó — kiểm tra quyền tài liệu trước. Thêm câu từ hội thoại thật: `npm run eval:golden:build` rồi `eval:golden:promote`.

Chỉ số vận hành từ nhật ký chat (đường xử lý, v2 trả lời trọn/dự phòng, chỉ tiêu, mục RAG và định tuyến) — chỉ đọc, ghi HTML/JSON vào `output/pipeline-metrics/`:

```powershell
npm run report:pipeline -- --days 30
```

Backend dùng `node:http` hoặc `node:https` khi cấu hình TLS, chưa dùng Fastify. Dữ liệu ứng dụng lưu PostgreSQL qua `storage.run/flush` bất đồng bộ; service thao tác view riêng từng operation. Commit hợp nhất thay đổi theo record trong transaction ngắn. HTTP success/cookie và SSE final chỉ gửi sau commit; progress SSE vẫn truyền khi xử lý. File tài liệu/export ở filesystem, dữ liệu nghiệp vụ ở SQL Server, vector ở Qdrant. Redis/BullMQ và parser/embedding Python service vẫn là định hướng.

## Cấu trúc thư mục

```text
.
|-- server.js                         # Entrypoint HTTP server
|-- src/
|   |-- frontend/
|   |   |-- index.html                # Dashboard shell
|   |   |-- login.html
|   |   |-- views/                    # Các trang chức năng
|   |   |-- js/                       # Vanilla JS modules
|   |   |-- css/
|   |   `-- embed/                    # Embed chat widget
|   `-- backend/
|       |-- routes/router.js          # REST và static-file router
|       |-- intelligent_core/         # Điểm vào chat (core.js), tool registry, adapters, guardrails
|       |-- agent_core/
|       |   |-- harness/              # Guarded harness, completion policy, budget
|       |   |-- pipeline/             # Luồng hợp đồng v2: catalog, compiler, câu trả lời tài liệu/trò chuyện
|       |   |-- tools/                # Công cụ cho vòng agent
|       |   `-- workflows/            # Workflow engine
|       |-- governance/               # Bộ điều phối, quyền tài nguyên/gửi model, chỉ tiêu, SQL policy
|       |-- automation/               # Catalog quy trình, template, runtime, nguồn dữ liệu, MCP soạn quy trình
|       |-- skill_core/               # Skill registry cho tab Skills
|       |-- memory_core/              # Memory, tham chiếu, trạng thái hội thoại tài liệu
|       |-- training_core/            # Đánh giá, chỉ số đường xử lý, vòng học từ phản hồi
|       |-- knowledge_core/           # Library, Watch Folder, cắt đoạn, truy hồi
|       |   `-- rag/                  # Dịch vụ RAG: hiểu câu hỏi, tín hiệu, đóng gói, kiểm chứng
|       |-- services/                 # SQL, Qdrant, provider, auth, logs...
|       |-- storage/                  # Async operation scope, PostgreSQL repository/outbox
|       `-- utils/storage_helper.js   # Chuyển loadJson/saveJson sang storage theo backend
|-- migrations/postgres/              # SQL migration có checksum
|-- compose.docker.yml                # PostgreSQL 18, Qdrant, named volumes và healthcheck
|-- data/                             # File tài liệu/export và JSON legacy giữ làm bản sao
|   `-- backup/                       # Backup migration cục bộ, không dùng ở runtime
|-- scripts/
|   `-- eval/                         # Live eval, golden candidates, chấm điểm truy hồi
|-- tests/fixtures/                   # Bộ câu chuẩn: live eval, truy hồi, định tuyến, chọn schema
|-- docs/                             # Master plan và implementation plans
|-- .agents/                          # Quy tắc dành cho coding agents
|-- package.json
`-- .env.example
```

## API chính

API bổ sung: `POST /api/auth/change-password`, `GET/POST /api/page-chat/sessions`, `GET /health/live` và `GET /health/ready`. Readiness hiện kiểm tra migration 003, database live và account; workflow cần thêm migration 004 (`npm run db:migrate`). PostgreSQL lỗi không tự ghi về JSON.

Phần lớn API yêu cầu session cookie sau khi đăng nhập.

| Method | Endpoint | Mục đích |
|---|---|---|
| `POST` | `/api/auth/login` | Đăng nhập |
| `POST` | `/api/auth/logout` | Đăng xuất |
| `GET` | `/api/auth/me` | Lấy account hiện tại |
| `GET` | `/api/chat-history?summary=1` | Thống kê nhẹ cho Tổng quan/Analytics, lọc theo quyền tài khoản |
| `GET` | `/api/chat-history?list=1` | Danh sách audit không kèm JSON chẩn đoán đầy đủ |
| `GET` | `/api/chat-history?id=<audit-id>` | Chi tiết một lượt chat, gồm tool execution; kiểm tra quyền sở hữu |
| `GET` | `/api/chat-feedback?summary=1` | Thống kê đánh giá cho biểu đồ |
| `GET` | `/api/chat-feedback?list=1` | Nội dung đánh giá và các trường audit phục vụ kiểm duyệt |
| `GET` | `/api/governance/operations` | Báo cáo vận hành rút gọn, chỉ dành cho admin |
| `GET` | `/api/sql/sources` | Danh sách SQL sources |
| `POST` | `/api/sql/ingest-ddl` | Nạp schema từ DDL |
| `POST` | `/api/sql/add-live` | Thêm live SQL Server source |
| `POST` | `/api/sql/test-source` | Kiểm tra đúng một live SQL source bằng truy vấn read-only |
| `GET` | `/api/dictionary` | Data Dictionary |
| `GET` | `/api/glossary` | Business Glossary |
| `POST` | `/api/qdrant/sync` | Đồng bộ schema sang Qdrant |
| `GET` | `/api/qdrant/status` | Trạng thái Qdrant |
| `POST` | `/api/intelligent-core/chat` | Agentic chat và tool calling |
| `POST` | `/api/intelligent-core/chat/stream` | SSE tiến trình và phản hồi cuối |
| `GET` | `/api/training-report` | Báo cáo đánh giá và cải tiến |
| `POST` | `/api/text2sql` | Chat/Text-to-SQL với provider tùy chọn |
| `GET` | `/api/ai-providers` | Danh sách AI providers |
| `POST` | `/api/ai-providers/add` | Thêm provider |
| `POST` | `/api/ai-providers/test` | Kiểm tra provider |
| `POST` | `/api/ai-providers/activate` | Kích hoạt provider |
| `POST` | `/api/v1/chat/completions` | OpenAI-compatible response cơ bản |
| `GET` | `/api/library` | Danh sách metadata tài liệu |
| `POST` | `/api/library/add` | Upload, parse, chunk và index tài liệu |
| `POST` | `/api/library/delete` | Xóa tài liệu, nội dung và vector |
| `GET` | `/api/watchfolder` | Danh sách thư mục được giám sát |
| `GET` | `/api/watchfolder/logs` | Live Audit Logs của Watch Folder |
| `GET` | `/api/training/skills` | Danh sách skill và trạng thái cấu hình |
| `POST` | `/api/training/skills/save` | Lưu chỉnh sửa skill |
| `GET` | `/api/mcp/servers` | Danh sách và trạng thái MCP |
| `POST` | `/api/mcp/add` | Thêm và thử kết nối MCP |
| `POST` | `/api/mcp/connect` | Kết nối lại MCP theo ID |
| `POST` | `/api/mcp/delete` | Gỡ MCP server |
| `GET` | `/api/embed/configs` | Danh sách cấu hình Embed |
| `POST` | `/api/embed/chat` | Chat qua Embed ID; public có kiểm tra domain |
| `GET` | `/health/live`, `/health/ready` | Endpoint health cơ bản, không xác nhận mọi dịch vụ phụ trợ |
| `GET/PUT` | `/api/workflow-plugins/settings` | Xem/cấu hình bật workflow |
| `GET/POST` | `/api/workflow-plugins` | Catalog và import gói (admin) |
| `GET/POST` | `/api/question-templates` | Liệt kê/tạo mẫu nghiệp vụ |
| `GET/POST` | `/api/automation-runs` | Liệt kê/tạo run theo owner |
| `POST` | `/api/automation-runs/:id/inputs`, `.../resume`, `.../cancel` | Bổ sung input, tiếp tục hoặc hủy run |
| `GET` | `/api/automation-runs/:id/artifacts/:artifactId` | Tải file theo owner và hạn tải |

Xem trang **API & SDK** trong dashboard để tạo API key và cấu hình embed chat. Endpoint `/api/v1/chat/completions` hiện chỉ tương thích một phần với OpenAI API; chưa hỗ trợ đầy đủ streaming và toàn bộ tham số chuẩn.

## Kiểm tra mã nguồn

Kiểm thử tập trung cho đợt tối ưu hiệu suất tải tab:

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/analytics.test.js tests/analytics_summary.test.js tests/audit_reader.test.js tests/governance_loading.test.js tests/tab_read_scopes.test.js
```

Các kiểm thử bao gồm phạm vi kho dữ liệu, quyền đọc audit, giải mã token đúng vị trí, tải JSON theo yêu cầu và tải song song các phần độc lập. Script đo trên dữ liệu thật ở mục hiệu suất phía trên là bước đối chiếu bổ sung; không thay thế toàn bộ bộ kiểm thử.

Lần chạy ngày **26/10/2026**: `npm test` **1.079 đạt, 14 bỏ qua, không có lỗi** (1.093 test). Nhóm `document` + `routing` của live eval trên Google Gemini đạt **18/18** sau khi cấp quyền tài liệu. Unit test sử dụng fixture/mock, không thay thế nghiệm thu SQL nghiệp vụ, retrieval hoặc provider thật. Test PostgreSQL cần credentials bootstrap và database test riêng:

```powershell
npm run test:storage
```

Đã đo thời gian snapshot từng tab trên dữ liệu hiện tại; số liệu này chưa phải thời gian tải trang end-to-end hoặc p95 tải lớn.

Project có tests cho guarded harness, luồng v2, Memory Core, Training Core, RAG và định tuyến tài liệu, bảo vệ dữ liệu nhạy cảm, workflow, adapters, settings, SQL/schema context và export. Unit test không thay thế baseline end-to-end với SQL source, Qdrant và LLM thật:

```powershell
npm test
```

Các script bổ sung:

```powershell
npm run eval:local                    # smoke eval protocol/format
npm run eval:workflows                # regression workflow/template/runtime
npm run eval:retrieval                # recall@k/MRR truy hồi tài liệu theo chế độ (chỉ đọc, chỉ gọi model nhúng)
npm run eval:routing                  # câu hỏi tới tài liệu/dữ liệu/trò chuyện, quét ngưỡng (không gọi model trả lời)
npm run eval:schema                   # chọn bảng đúng cho câu hỏi dữ liệu
npm run eval:live                     # model + dữ liệu thật (tốn chi phí, dùng --only)
npm run eval:governed:replay          # phát lại lượt đã ghi qua harness có quản trị
npm run eval:golden:build             # ứng viên câu chuẩn từ hội thoại thật (rồi eval:golden:promote)
npm run learn:build                   # bản nháp học từ phản hồi (rồi learn:approve)
npm run metrics:seed                  # xem trước chỉ tiêu nghiệp vụ (--apply để ghi kho ứng dụng)
npm run report:pipeline               # chỉ số đường xử lý từ nhật ký chat
npm run eval:local:semantic           # validate corpus semantic offline
npm run eval:local:semantic:live      # chạy model + SQL source eval riêng
npm run migrate:dictionary-identity   # migration identity + backup
npm run sanitize:chat-data            # loại secret khỏi lịch sử chat đã lưu
npm run training:collect
npm run training:evaluate
npm run eval:memory                   # đánh giá Memory Core
npm run eval:sql                      # SQL security corpus
npm run benchmark:http               # benchmark HTTP
npm run backup                       # backup dữ liệu
npm run restore -- <backup-path>      # xem yêu cầu/tham số trong scripts/backup_restore.js
```

Có thể kiểm tra cú pháp toàn bộ JavaScript bằng PowerShell:

```powershell
$files = rg --files -g '*.js' src server.js
$failed = @()
foreach ($file in $files) {
  node --check $file
  if ($LASTEXITCODE -ne 0) {
    $failed += $file
  }
}
if ($failed.Count -gt 0) {
  throw "JavaScript syntax check failed: $($failed -join ', ')"
}
```

Truy hồi tài liệu chạy theo `hiểu câu hỏi -> BGE-M3/Qdrant + BM25 -> RRF -> BGE reranker (tùy chọn) -> đóng gói`. Bộ câu chuẩn `tests/fixtures/retrieval_golden.json` (65 câu, bản nháp chờ duyệt) xác định đoạn đúng bằng cụm bằng chứng, nên không vỡ khi cắt đoạn lại; `tests/fixtures/routing_golden.json` (64 câu) cho định tuyến. Báo cáo ghi vào `data/eval/`:

```powershell
npm run eval:retrieval                                        # mọi chế độ: hybrid, lexical, v2_tool, pipeline...
npm run eval:retrieval -- --baseline data/eval/retrieval/<cu>.json   # so với lần đo trước
npm run eval:retrieval -- --rechunk                           # mô phỏng lập chỉ mục lại với bộ cắt đoạn hiện tại
npm run eval:routing                                          # đường đi của câu hỏi + quét ngưỡng RAG_ROUTING_MIN_SCORE
```

Chạy lại `eval:routing` mỗi khi thêm tài liệu vào thư viện, vì phân bố điểm khớp thay đổi.

Sau khi đổi model hoặc collection, bật `KNOWLEDGE_REINDEX_ON_START=true` đúng một lần để tái lập chỉ mục, sau đó chuyển lại `false`. Không dùng fallback deterministic ở production; cấu hình mẫu mặc định `EMBEDDING_FALLBACK_MODE=error` để tránh âm thầm ghi pseudo-vector.

Các kế hoạch Phase 1-2 đã xác định unit test, integration test, security test và load test là điều kiện nghiệm thu bắt buộc.

## Cảnh báo bảo mật

Phiên bản hiện tại là prototype và **không nên expose trực tiếp ra Internet**.

- Credential trên PostgreSQL dùng AES-256-GCM với context record; token/API key có hash lookup. JSON legacy và snapshot cũ có thể vẫn chứa secret, cần bảo vệ như dữ liệu nhạy cảm.
- DTO provider không trả API key gốc; credential thực thi chỉ được đọc trong backend.
- Password tài khoản mới dùng scrypt; hash SHA-256 cũ được nâng cấp sau lần đăng nhập hợp lệ.
- Admin được bootstrap bằng `BOOTSTRAP_ADMIN_PASSWORD`; dữ liệu cũ có thể vẫn chứa tài khoản/mật khẩu từ bản trước.
- Quyền theo từng tài liệu (đọc, độ nhạy, model được nhận nội dung) đã có; chưa có RBAC theo thư mục.
- Chưa có CSRF protection hoàn chỉnh và cookie production hardening.
- SQL Connector phải sử dụng database account read-only riêng.
- Kết quả SQL loại các trường password/secret/token và các cột audit `CreateUser`, `CreateDate`, `UpdateUser`, `UpdateDate` trước khi gửi model hoặc UI.
- Các file `data/*.json`, `.env`, archive và log có thể chứa secret hoặc dữ liệu nghiệp vụ.
- Server bind `HOST`, mặc định `127.0.0.1`.
- Runtime PostgreSQL có transaction memory/message/audit, conflict detection và lease. JSON chỉ dùng khi chọn backend `json` tường minh cho fixture/bootstrap/rollback đã kiểm chứng. Session touch theo `SESSION_TOUCH_INTERVAL_MS` (mặc định 5 phút).
- Khóa mã hóa ở `APP_DATA_ENCRYPTION_KEY_FILE`, ngoài repo. Backup riêng khóa ở nơi an toàn; dump database không đủ giải mã credential. Process giữ khóa trong RAM; thay file khóa cần restart và quy trình re-encrypt.

## Backup và vận hành PostgreSQL

```powershell
npm run backup        # Filesystem + app.dump và checksum khi dùng PostgreSQL
npm run backup:pg     # Dump schema app, gồm lịch sử giao diện
npm run restore:pg -- <file.dump> knowledgehub_restore_kiemtra
npm run data:pg:export -- <thu-muc-moi>
```

Backup và import chung PostgreSQL + Qdrant (ba collection schema/tài liệu/workflow) và file thư viện:

Trong giao diện admin, mở **Cài đặt hệ thống → PostgreSQL + Qdrant**. Nút **Tạo backup ngay** tự tạm dừng request và worker ghi của ứng dụng trong lúc chụp dữ liệu, rồi mở lại. Tải file `.khbackup` về để cất giữ. Để khôi phục **vào database hiện tại**, tải file lên, kiểm tra và xem kế hoạch; nhập lại đúng tên database để xác nhận. Chức năng này cần chạy bằng `npm start`: supervisor dừng server, tạo một gói backup an toàn của dữ liệu hiện tại, ghi đè schema `app` và ba collection Qdrant, phục hồi file thư viện rồi khởi động lại. Nếu có lỗi sau khi bắt đầu ghi đè, server sẽ không tự khởi động; xem báo cáo `*-restore-current-report.json` và gói backup an toàn trước khi xử lý tiếp. Các tiến trình ghi bên ngoài ứng dụng vẫn cần được dừng riêng.

```powershell
# Dừng ứng dụng, supervisor và mọi job ghi PostgreSQL/Qdrant trước khi chạy.
$env:BACKUP_APP_STOPPED='1'
npm run backup:all
npm run backup:verify -- <thu-muc-goi-backup>
npm run backup:import -- <thu-muc-goi-backup> knowledgehub_restore_kiemtra --dry-run
npm run backup:import -- <thu-muc-goi-backup> knowledgehub_restore_kiemtra
Remove-Item Env:BACKUP_APP_STOPPED
```

Lệnh CLI `backup:import` vẫn tạo database mới và ba collection Qdrant mới có tiền tố `<ten_database>_`; không đổi cấu hình ứng dụng. File `library_files` và `library_content` được giữ trong `<goi>/files` để sao chép vào `KNOWLEDGEHUB_DATA_DIR` của môi trường đích khi cutover. Xem `*-import-report.json` ở thư mục cha gói trước khi chuyển traffic; chỉ chuyển khi `readyForCutover=true`. Khóa `APP_DATA_ENCRYPTION_KEY_FILE` phải được cấp riêng ở đích. Snapshot Qdrant cần server tương thích; nên diễn tập import ở môi trường riêng trước. Giữ gói backup ngoài máy chủ theo chính sách lưu giữ và bảo vệ như dữ liệu nhạy cảm.

Lệnh CLI `restore:pg` chỉ tạo database mới tên `knowledgehub_restore_*`. UI có thao tác riêng để khôi phục DB hiện tại sau khi dừng server và tạo backup an toàn. Export JSON legacy chưa bao gồm `ui_chat_sessions`; phục hồi đầy đủ cần database dump, file tài liệu và khóa mã hóa. Sau khi PostgreSQL đã nhận ghi mới, không đổi về JSON cũ hoặc chạy importer ghi đè. Volume Docker không thay thế backup; lịch backup tự động/PITR chưa được cấu hình.

Request chat có `X-Request-Id` cùng owner/path/body không nhân đôi memory/audit; receipt hiện kiểm tra lúc commit nên retry vẫn có thể gọi model/tool. Worker lease chống chạy đồng thời nhưng chưa cam kết exactly-once cho tác động ngoài database. Mutation/route chưa tối ưu vẫn có thể đọc snapshot đầy đủ; phân trang audit và tối ưu tải lớn còn trong backlog.

Trước khi chia sẻ repo hoặc triển khai:

1. Rotate/revoke mọi API key từng lưu trong repo hoặc archive.
2. Không commit `.env` và `data/*.json` có dữ liệu thật.
3. Thay tài khoản/mật khẩu mặc định.
4. Giới hạn bind/firewall ở localhost hoặc mạng tin cậy.
5. Hoàn thành Security Gate trong kế hoạch Phase 1-2.

## Roadmap

Thứ tự ưu tiên backend hiện tại: **bảo vệ secret/quyền và dữ liệu → ổn định vận hành/đo hiệu năng → chất lượng câu trả lời → mở rộng lưu trữ và worker**. Các Phase dưới đây là định hướng dài hạn, không phải chức năng đã hoàn thành. Việc gần nhất cho RAG nằm ở mục 8 của [docs/RAG_REVIEW_261026.html](docs/RAG_REVIEW_261026.html): duyệt hai bộ câu chuẩn nháp, hiệu chỉnh ngưỡng định tuyến theo dữ liệu thật, chuyển kiểm chứng trích dẫn từ ghi nhận sang sửa/bỏ trích dẫn, thử reranker, OCR.

### Phase 1 - Nền tảng MVP

- PostgreSQL app store đã triển khai; tiếp tục query theo domain/cursor, phân trang audit, benchmark p95 và giám sát pool/dung lượng.
- Redis/BullMQ ingestion queue và dead-letter queue.
- Hoàn thiện versioning tài liệu và transaction/reconciliation giữa metadata, file và vector.
- Chunking đã có locator theo page/sheet/section và bộ cắt đoạn `structured-v2`; còn semantic/token-aware chunking.
- Kiểm chứng trích dẫn: đã kiểm tra số/ngày/mã ở chế độ ghi nhận; còn chặn/sửa và mở đúng vị trí nguồn.
- Sensitivity-aware routing theo tài liệu đã có (`governedPolicy`); còn circuit breaker cho AI Provider.
- Docker Compose và mở rộng kiểm thử triển khai; script backup/restore và automated tests đã có trong repository.

### Phase 2 - Chất lượng tìm kiếm

- Duyệt và mở rộng golden dataset truy hồi/định tuyến (đã có bản nháp), đưa `eval:retrieval`/`eval:routing` vào CI.
- Vận hành BGE Reranker service và benchmark so với RRF baseline.
- Auto Summary và Related Documents.
- Provider routing, circuit breaker và cost dashboard.
- Zero-downtime re-embedding, load test và release hardening.

### Phase 3-4

- Phase 3: RBAC chi tiết, persistent Knowledge Graph, LLM entity/relation extraction, community summary, Wiki và mở rộng SDK/API. MCP client kết nối server ngoài đã triển khai.
- Phase 4: OCR, Cloud Sync, mở rộng cộng tác nhiều người dùng, AI Agents, plugin sandbox và enterprise operations. Session/account và catalog workflow hiện đã có; sandbox chạy code tùy ý chưa triển khai.

Phase 3-4 hiện mới ở mức roadmap; chưa có workflow/task manifest đủ chi tiết để giao tự động cho coding agents. Phase 5 chưa được định nghĩa trong master plan hiện hành.

## Tài liệu

- [Đánh giá RAG tài liệu, kế hoạch và tiến độ (26/10/2026)](docs/RAG_REVIEW_261026.html)
- [Rà soát trí tuệ backend AI (26/10/2026)](docs/BACKEND_AI_INTELLIGENCE_REVIEW_261026.html)
- [Rà soát hệ thống harness và SQL (23/10/2026)](docs/HARNESS_SQL_SYSTEM_REVIEW_20261023.html), [audit harness](docs/HARNESS_FULL_AUDIT_20261023.md)
- [Chế độ embedding: vector hoặc chỉ từ khóa](docs/EMBEDDING_MODES.md)
- [Soạn quy trình qua MCP](docs/WORKFLOW_AUTHORING_MCP.md), [MCP quy trình chạy trên máy chủ](docs/WORKFLOW_HOSTED_MCP.md)
- [Xử lý tệp đính kèm trong chat](docs/CHAT_ATTACHMENT_PROCESSING_PLAN_241026.md), [hiểu hình ảnh trong chat](docs/CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md)
- [Vai trò và quyền tài khoản](docs/ACCOUNT_ROLES_PERMISSIONS_171026.md), [quyền dữ liệu theo dòng](docs/ROW_LEVEL_DATA_ACCESS_PLAN_241026.md)
- [Định danh Embed](docs/embed-identity.md)

## Quy ước đóng góp

- Không đưa secret hoặc dữ liệu SQL thật vào source control.
- Không dùng dữ liệu giả để biểu diễn trạng thái của SQL source đã kết nối.
- UI sử dụng Inter và Font Awesome theo quy ước hiện tại.
- Giữ thay đổi nhỏ, có phạm vi rõ và tránh sửa file không liên quan.
- Tính năng mới cần có acceptance criteria và test tương ứng.
- Nếu thay đổi schema, API hoặc security model, cần ghi lại migration/compatibility impact.

## License

Project hiện khai báo license `ISC` trong `package.json`. Trước khi phân phối công khai, cần bổ sung file `LICENSE` chính thức và xác nhận lại chủ sở hữu/quyền phân phối mã nguồn.

### Reasoning trong giao diện chat

Khung Reasoning xuất hiện khi provider thực sự gửi nội dung suy luận hoặc bản tóm tắt được công khai qua API. Nội dung cập nhật qua SSE trong lúc chờ câu trả lời, có thể mở/thu gọn và được giữ trong phần Thinking của kết quả. Không tạo nội dung giả khi model không gửi Reasoning.

- Ollama: đọc `message.thinking` từ NDJSON. Tôn trọng `provider.think` và `LOCAL_MODEL_THINK`; nếu chưa cấu hình thì dùng mặc định của model khi chat streaming. Cấu hình `false` vẫn tắt thinking.
- OpenAI-compatible: đọc `reasoning_content` hoặc `reasoning` từ Chat Completions SSE. Ghép lại nội dung và tool arguments trước khi chạy tool. Nếu endpoint báo không hỗ trợ streaming thì thử lại chế độ JSON; có thể đặt `supportsStreaming: false` trong cấu hình provider.
- OpenAI chính thức: các model reasoning o1/o3/o4 và GPT-5/GPT-6 dùng Responses API với `reasoning.summary: auto`; cũng có thể chọn `apiFormat: openai-responses`. Giữ các reasoning item mã hóa trong ngữ cảnh tool của cùng yêu cầu.
- Gemini 2.5/3: bật `includeThoughts` và nhận thought summaries từ `streamGenerateContent`; giữ thought signatures cho lượt tool tiếp theo.
- Anthropic: adapter hiện giữ luồng cũ, chưa bật extended thinking.

Giới hạn phần hiển thị 32.000 ký tự mỗi lượt gọi model. Giao diện dùng văn bản thuần để nội dung provider không được thực thi như HTML. Không hỗ trợ Reasoning thì chỉ hiện các bước tiến trình hiện có. Việc summary xuất hiện sớm hay muộn phụ thuộc provider.

Kiểm thử: `node --require ./tests/helpers/setup_isolated_data.js --test tests/reasoning_stream.test.js tests/chat_pending_panel.test.js`.

Gemini Flash-Lite có thể không gửi summary ở mức thinking mặc định. Chat streaming hiện yêu cầu thinking level `MEDIUM` cho Gemini 3 Flash/Lite (`HIGH` cho Pro), hoặc budget 1024 cho Gemini 2.5 Flash-Lite. Có thể ghi đè bằng `provider.thinkingLevel` / `AI_GEMINI_THINKING_LEVEL`, và `provider.thinkingBudget` / `AI_GEMINI_THINKING_BUDGET`. Điều này có thể tăng thời gian phản hồi và số token suy luận. Các lượt gọi JSON không streaming (lập hợp đồng v2, kiểm tra) giữ cấu hình cũ; không bảo đảm mỗi câu đều có summary. Ollama vẫn tôn trọng `LOCAL_MODEL_THINK=false`.
