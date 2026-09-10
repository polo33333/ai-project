# KnowledgeHub AI

KnowledgeHub AI là nền tảng tri thức self-hosted đang được phát triển bằng Node.js và Vanilla HTML/CSS/JavaScript. Phiên bản hiện tại tập trung vào quản lý tri thức từ SQL Server, Data Dictionary, Business Glossary, Text-to-SQL, chat đa nhà cung cấp AI và các công cụ phân tích dữ liệu.

> **Trạng thái:** MVP đang phát triển. Pipeline tài liệu `Import/Watch Folder -> Parse -> Chunk -> BGE-M3 -> Qdrant -> Hybrid Retrieval -> LLM` đã có lát cắt chạy thật, nhưng metadata vẫn dùng JSON, ingestion chạy trong tiến trình Node.js và chưa có queue/DLQ production. Xem [Trạng thái triển khai](#trạng-thái-triển-khai) trước khi sử dụng với dữ liệu thật.

Rà soát backend và local model gần nhất ngày **10/09/2026**. Xem [kế hoạch tối ưu Local Model v2](docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md) và [đánh giá backend](docs/Backend_Review_Development_Plan-080926.md).

## Tính năng hiện có

### SQL Knowledge Connector

- Nạp schema từ file DDL hoặc kết nối trực tiếp Microsoft SQL Server.
- Đọc table, column, primary key và metadata schema.
- Quản lý Data Dictionary, quan hệ bảng và Business Glossary.
- Đồng bộ schema, relationship và glossary sang Qdrant.
- Text-to-SQL với giới hạn câu lệnh `SELECT/WITH` và `TOP 100` mặc định.
- Thực thi truy vấn read-only, hiển thị bảng kết quả, biểu đồ và xuất dữ liệu.

### AI và chat

- Agentic loop: LLM có thể lựa chọn và gọi công cụ, nhận kết quả rồi tổng hợp câu trả lời.
- Adapter cho Ollama, OpenAI-compatible, Google Gemini và Anthropic.
- Quản lý AI Provider: thêm, sửa, xóa, kích hoạt, lấy danh sách model và kiểm tra kết nối.
- Persona, lịch sử hội thoại, audit log và model selector.
- Công cụ tích hợp: kiểm tra/sửa/thực thi SQL, tìm schema/glossary/Qdrant, tính toán, biểu đồ và export.
- Local Model Harness: kiểm tra tham số công cụ, phục hồi lỗi, tổng hợp kết quả và kiểm tra yêu cầu biểu đồ/export.
- `skill_core`: chọn contract `record_lookup` hoặc `aggregate_report` theo request plan; hỗ trợ few-shot tương thích với schema và được kiểm soát bằng feature flag.
- Request budget dùng chung cho model call, SQL attempt và deadline; truyền abort signal xuống SQL connector.
- Memory Core: phân loại follow-up/chủ đề, lưu references và kiểm tra chất lượng trước khi ghi nhớ hội thoại.
- Streaming tiến trình qua `/api/intelligent-core/chat/stream`, gồm sự kiện tiến trình và kết quả cuối; không đồng nghĩa streaming token đầy đủ.
- Training Core: thu thập case, đánh giá SQL/câu trả lời, phân loại lỗi và tạo đề xuất cải tiến; chưa phải hệ thống fine-tuning model.
- Workflow engine: thực thi bước tự động, điều kiện, retry và trace.

### API và quản trị

- Giao diện dashboard bằng HTML/CSS/JavaScript thuần, không có build step frontend.
- Session authentication và tài khoản có role.
- API key nội bộ, embed-chat configuration và endpoint OpenAI-compatible cơ bản.
- System logs, chat audit, analytics và system tools.
- Library hỗ trợ upload, parse PDF/DOCX/XLSX/CSV/TXT/SQL/Markdown, chunk, index, preview và xóa tài liệu.
- Watch Folder theo dõi filesystem thật, quét file ban đầu, chống trùng bằng `sourcePath` + SHA-256 và cập nhật lại document khi file đổi.
- UI Chat hiển thị mode retrieval, RRF/reranker, số chunk và nguồn tài liệu.
- MCP Sources vẫn ở mức prototype cấu hình.

## Trạng thái triển khai

| Khu vực | Trạng thái | Ghi chú |
|---|---|---|
| Vanilla web dashboard | Khả dụng | Phục vụ trực tiếp từ Node.js |
| SQL Server Connector | Khả dụng | Hỗ trợ DDL và live connection |
| Data Dictionary/Glossary | Khả dụng | Có lưu trữ và đồng bộ Qdrant |
| Text-to-SQL | Khả dụng có giới hạn | Cần dùng SQL account read-only ở môi trường thật |
| AI Provider adapters | Khả dụng | Có fallback tuần tự theo priority giữa các provider đã cấu hình |
| Intelligent Core/tools | Khả dụng | Single-agent tool-calling loop |
| Qdrant schema search | Khả dụng khi có Qdrant/BGE-M3 | Collection schema v2 dùng embedding thật 1024 chiều; fallback deterministic mặc định tắt |
| Dictionary identity | Đã triển khai | Phân biệt nguồn kết nối, database, schema, table và column; backup migration nằm trong `data/backup/` |
| Local skill/few-shot | Đã triển khai, có feature flag | Hai skill nền đã nối vào Local Harness; cần semantic eval trước khi chọn cấu hình mặc định cho môi trường khác |
| Semantic SQL eval | Runner offline khả dụng | Logic chấm điểm ở `scripts/eval/`; corpus hiện có 12 case, live baseline phụ thuộc data source eval phù hợp |
| Library | Khả dụng ở mức MVP | Upload/parse/chunk/index thật; chống upload trùng nội dung bằng SHA-256 |
| Watch Folder | Khả dụng ở mức MVP | Theo dõi filesystem, debounce, retry và cập nhật idempotent theo file nguồn |
| MCP Sources | Prototype | CRUD cấu hình; chưa có MCP handshake/discovery/execution thật |
| PostgreSQL/Redis/BullMQ | Chưa triển khai | Đang nằm trong kế hoạch hoàn thiện Phase 1 |
| Document Hybrid Search | Đã triển khai, phụ thuộc dịch vụ | BGE-M3 dense + BM25 + RRF; khi BGE-M3 lỗi vẫn tra cứu BM25 nhưng chất lượng semantic giảm |
| BGE Reranker | Sẵn sàng tích hợp | Bật bằng `RERANKER_ENABLED=true` khi reranker HTTP hoạt động |
| GraphRAG | Bản router/graph retrieval nền tảng | Chỉ kích hoạt cho câu hỏi quan hệ; chưa có persistent knowledge graph/community summary |

## Yêu cầu hệ thống

- **Node.js 18 trở lên** — mã nguồn sử dụng Fetch API tích hợp.
- npm.
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

# Qdrant
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=database_schema_v2
QDRANT_VECTOR_SIZE=1024
QDRANT_DOCUMENT_COLLECTION=knowledge_documents_bge_m3_v1
QDRANT_DOCUMENT_VECTOR_SIZE=1024

# Document embedding
EMBEDDING_PROVIDER=ollama
EMBEDDING_BASE_URL=http://127.0.0.1:11434
EMBEDDING_MODEL=bge-m3
EMBEDDING_FALLBACK_MODE=error

# Hybrid retrieval
RETRIEVAL_CANDIDATE_LIMIT=30
RRF_K=60
AI_DOCUMENT_CONTEXT_CHARS=12000

# Optional reranker and graph retrieval
RERANKER_ENABLED=false
RERANKER_BASE_URL=http://127.0.0.1:8081
RERANKER_MODEL=bge-reranker-v2-m3
GRAPHRAG_ENABLED=true

# Bật đúng một lần sau khi đổi model/collection, rồi chuyển lại false
KNOWLEDGE_REINDEX_ON_START=false

# Intelligent Core
AI_MAX_TOOL_ITERATIONS=10
AI_DEFAULT_TIMEOUT_MS=30000
LOCAL_MODEL_HARNESS_ENABLED=true
LOCAL_MODEL_SKILL_CORE_ENABLED=false
LOCAL_MODEL_FEW_SHOT_ENABLED=false
LOCAL_MODEL_MAX_MODEL_CALLS=9
LOCAL_MODEL_MAX_SQL_CALLS=3

# Local JSON log retention
MAX_CHAT_HISTORY=5000
```

Không lưu API key, password hoặc connection string thật vào Git. AI Provider hiện được cấu hình qua giao diện quản trị và đang lưu trong local JSON; xem phần [Cảnh báo bảo mật](#cảnh-báo-bảo-mật).

### 3. Khởi động dịch vụ phụ trợ

Qdrant là tùy chọn cho chat chung nhưng cần cho dense search và đồng bộ vector. Ví dụ chạy Qdrant bằng Docker:

```powershell
docker run --name knowledgehub-qdrant -p 6333:6333 -p 6334:6334 -v knowledgehub_qdrant:/qdrant/storage qdrant/qdrant
```

Nếu dùng Ollama cho embedding, khởi động Ollama và tải `bge-m3`. LLM Chat là model/provider riêng; BGE-M3 không sinh câu trả lời. BM25 và RRF không cần model. Reranker là dịch vụ tùy chọn và không dùng endpoint embedding của Ollama trong triển khai hiện tại.

### 4. Chạy KnowledgeHub

```powershell
npm start
```

Nếu đã tự khởi động các dịch vụ phụ trợ, có thể chạy trực tiếp bằng `npm run dev` hoặc `node server.js`; cách này không gọi script PowerShell khởi động Ollama/Qdrant.

Trên Windows, `npm start` gọi `scripts/start-local.ps1` và tự động:

1. Đọc cấu hình `.env`.
2. Khởi động Ollama native nếu API `11434` chưa hoạt động.
3. Tải `EMBEDDING_MODEL` nếu model chưa có trên máy.
4. Warm-up endpoint embedding để model sẵn sàng trước khi nhận tài liệu.
5. Khởi động Qdrant từ `QDRANT_EXE` nếu Qdrant chưa chạy.
6. Khởi động KnowledgeHub bằng `node server.js`.

Các lần chạy sau không tải lại model vì Ollama đã lưu model cục bộ. Nếu Ollama hoặc Qdrant đã chạy, script chỉ kiểm tra và sử dụng tiến trình hiện có.

Mở:

- Dashboard: <http://localhost:3000>
- Login: <http://localhost:3000/login.html>

Tài khoản khởi tạo của bản prototype:

```text
Username: admin
Password: admin123
```

**Phải đổi thông tin đăng nhập này trước khi cho phép máy khác truy cập.** Phiên bản hiện tại chưa có quy trình bắt buộc đổi password lần đầu.

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
  |     |-- Tool registry
  |     `-- Hybrid retrieval router
  |           |-- BGE-M3 dense search --> Qdrant
  |           |-- BM25 keyword search
  |           |-- RRF fusion
  |           |-- Optional BGE reranker
  |           `-- Graph co-occurrence branch
  |-- Library/Watch Folder ---------> Local files + extracted text
  |-- SQL Server Connector ------> Microsoft SQL Server
  |-- Qdrant Service ------------> Qdrant
  `-- Storage Helper ------------> data/*.json
```

Backend hiện dùng `node:http`, chưa dùng Fastify. Metadata đang lưu bằng JSON. Kiến trúc mục tiêu của Phase 1 sẽ chuyển metadata sang PostgreSQL, tác vụ bất đồng bộ sang Redis/BullMQ và parser/embedding sang Python FastAPI.

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
|       |-- intelligent_core/         # Agent loop, tools, adapters, guardrails
|       |-- agent_core/               # Local Harness, tools và workflow engine
|       |-- skill_core/               # Skill registry, selector và few-shot theo schema
|       |-- memory_core/              # Memory router, references và quality gate
|       |-- training_core/            # Case collection, evaluation và đề xuất
|       |-- knowledge_core/           # Library, Watch Folder và hybrid retrieval
|       |-- services/                 # SQL, Qdrant, provider, auth, logs...
|       `-- utils/storage_helper.js   # JSON persistence
|-- data/                             # Local runtime data; có thể chứa secret
|   `-- backup/                       # Backup migration cục bộ, không dùng ở runtime
|-- scripts/
|   `-- eval/                         # Semantic evaluator và logic benchmark
|-- docs/                             # Master plan và implementation plans
|-- .agents/                          # Quy tắc dành cho coding agents
|-- package.json
`-- .env.example
```

## API chính

Phần lớn API yêu cầu session cookie sau khi đăng nhập.

| Method | Endpoint | Mục đích |
|---|---|---|
| `POST` | `/api/auth/login` | Đăng nhập |
| `POST` | `/api/auth/logout` | Đăng xuất |
| `GET` | `/api/auth/me` | Lấy account hiện tại |
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

Xem trang **API & SDK** trong dashboard để tạo API key và cấu hình embed chat. Endpoint `/api/v1/chat/completions` hiện chỉ tương thích một phần với OpenAI API; chưa hỗ trợ đầy đủ streaming và toàn bộ tham số chuẩn.

## Kiểm tra mã nguồn

Project có tests cho Local Harness, Memory Core, Training Core, `skill_core`, semantic evaluator, bảo vệ dữ liệu nhạy cảm, workflow, adapters, settings, SQL/schema context, export và retrieval. Unit test không thay thế baseline end-to-end với SQL source, Qdrant và LLM thật:

```powershell
npm test
```

Các script bổ sung:

```powershell
npm run eval:local                    # smoke eval protocol/format
npm run eval:local:semantic           # validate corpus semantic offline
npm run eval:local:semantic:live      # chạy model + SQL source eval riêng
npm run eval:retrieval                # Recall@K/MRR retrieval
npm run migrate:dictionary-identity   # migration identity + backup
npm run sanitize:chat-data            # loại secret khỏi lịch sử chat đã lưu
npm run training:collect
npm run training:evaluate
```

Có thể kiểm tra cú pháp toàn bộ JavaScript bằng PowerShell:

```powershell
$files = rg --files -g '*.js' src server.js
foreach ($file in $files) {
  node --check $file
}
```

Retrieval mới chạy theo `BGE-M3/Qdrant + BM25 -> RRF -> BGE reranker (tùy chọn)`. Câu hỏi quan hệ được router bổ sung nhánh graph co-occurrence. Để chạy đánh giá Recall@K và MRR, sao chép/chỉnh `tests/fixtures/retrieval_golden.sample.json`, điền `documentId` thật rồi chạy:

```powershell
npm run eval:retrieval -- tests/fixtures/retrieval_golden.sample.json 5
```

Sau khi đổi model hoặc collection, bật `KNOWLEDGE_REINDEX_ON_START=true` đúng một lần để tái lập chỉ mục, sau đó chuyển lại `false`. Không dùng fallback deterministic ở production; cấu hình mẫu mặc định `EMBEDDING_FALLBACK_MODE=error` để tránh âm thầm ghi pseudo-vector.

Các kế hoạch Phase 1-2 đã xác định unit test, integration test, security test và load test là điều kiện nghiệm thu bắt buộc.

## Cảnh báo bảo mật

Phiên bản hiện tại là prototype và **không nên expose trực tiếp ra Internet**.

- API key của AI Provider hiện được lưu plaintext trong `data/ai_providers.json`.
- DTO provider không trả API key gốc; credential thực thi chỉ được đọc trong backend.
- Password tài khoản mới dùng scrypt; hash SHA-256 cũ được nâng cấp sau lần đăng nhập hợp lệ.
- Có tài khoản admin mặc định.
- Chưa có RBAC theo Library/folder/document.
- Chưa có CSRF protection hoàn chỉnh và cookie production hardening.
- SQL Connector phải sử dụng database account read-only riêng.
- Kết quả SQL loại các trường password/secret/token và các cột audit `CreateUser`, `CreateDate`, `UpdateUser`, `UpdateDate` trước khi gửi model hoặc UI.
- Các file `data/*.json`, `.env`, archive và log có thể chứa secret hoặc dữ liệu nghiệp vụ.
- `server.listen(PORT)` hiện không chỉ định host; URL localhost trong log không có nghĩa server chỉ lắng nghe localhost.
- JSON persistence đang ghi đồng bộ và chỉ log lỗi ghi; session cũng được persist sau mỗi request hợp lệ. Cần xử lý độ bền dữ liệu và đo hiệu năng trước khi triển khai nhiều người dùng.

Trước khi chia sẻ repo hoặc triển khai:

1. Rotate/revoke mọi API key từng lưu trong repo hoặc archive.
2. Không commit `.env` và `data/*.json` có dữ liệu thật.
3. Thay tài khoản/mật khẩu mặc định.
4. Giới hạn bind/firewall ở localhost hoặc mạng tin cậy.
5. Hoàn thành Security Gate trong kế hoạch Phase 1-2.

## Roadmap

Thứ tự ưu tiên backend hiện tại: **bảo vệ secret/quyền và dữ liệu → ổn định vận hành/đo hiệu năng → chất lượng câu trả lời → mở rộng lưu trữ và worker**. Xem backlog BE-01–BE-11 và tiêu chí nghiệm thu trong [kế hoạch backend](docs/Backend_Review_Development_Plan-080926.md). Các Phase dưới đây là định hướng dài hạn, không phải chức năng đã hoàn thành.

### Phase 1 - Nền tảng MVP

- PostgreSQL metadata store.
- Redis/BullMQ ingestion queue và dead-letter queue.
- Hoàn thiện versioning tài liệu và transaction/reconciliation giữa metadata, file và vector.
- Nâng chunking hiện tại lên semantic/token-aware chunking có locator theo page/sheet/section.
- Hoàn thiện citation validation và khả năng mở đúng vị trí nguồn.
- Hoàn thiện sensitivity-aware routing và circuit breaker cho AI Provider.
- Docker Compose, backup/restore và automated tests.

### Phase 2 - Chất lượng tìm kiếm

- Mở rộng golden dataset và đưa retrieval evaluation vào CI.
- Vận hành BGE Reranker service và benchmark so với RRF baseline.
- Auto Summary và Related Documents.
- Provider routing, circuit breaker và cost dashboard.
- Zero-downtime re-embedding, load test và release hardening.

### Phase 3-4

- Phase 3: RBAC, persistent Knowledge Graph, LLM entity/relation extraction, community summary, Wiki, MCP Server thật và SDK/API.
- Phase 4: OCR, Cloud Sync, Multi-user, AI Agents, plugin sandbox và enterprise operations.

Phase 3-4 hiện mới ở mức roadmap; chưa có workflow/task manifest đủ chi tiết để giao tự động cho coding agents. Phase 5 chưa được định nghĩa trong master plan hiện hành.

## Tài liệu

- [Đánh giá backend và kế hoạch phát triển — 08/09/2026](docs/Backend_Review_Development_Plan-080926.md)

- [KnowledgeHub Master Plan v3](docs/KnowledgeHub_Master_Plan_v3.docx)
- [Kế hoạch triển khai Phase 1-2 - bản nháp](docs/KnowledgeHub_Phase1_Phase2_Implementation_Plan_Draft.md)
- [Kế hoạch SQL Server Connector Phase 1](docs/Phase1_SQLServer_Connector_Plan.docx)

## Quy ước đóng góp

- Không đưa secret hoặc dữ liệu SQL thật vào source control.
- Không dùng dữ liệu giả để biểu diễn trạng thái của SQL source đã kết nối.
- UI sử dụng Inter và Font Awesome theo quy ước hiện tại.
- Giữ thay đổi nhỏ, có phạm vi rõ và tránh sửa file không liên quan.
- Tính năng mới cần có acceptance criteria và test tương ứng.
- Nếu thay đổi schema, API hoặc security model, cần ghi lại migration/compatibility impact.

## License

Project hiện khai báo license `ISC` trong `package.json`. Trước khi phân phối công khai, cần bổ sung file `LICENSE` chính thức và xác nhận lại chủ sở hữu/quyền phân phối mã nguồn.
