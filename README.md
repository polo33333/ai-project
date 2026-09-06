# KnowledgeHub AI

KnowledgeHub AI là nền tảng tri thức self-hosted đang được phát triển bằng Node.js và Vanilla HTML/CSS/JavaScript. Phiên bản hiện tại tập trung vào quản lý tri thức từ SQL Server, Data Dictionary, Business Glossary, Text-to-SQL, chat đa nhà cung cấp AI và các công cụ phân tích dữ liệu.

> **Trạng thái:** MVP đang phát triển. Pipeline tài liệu `Import/Watch Folder -> Parse -> Chunk -> BGE-M3 -> Qdrant -> Hybrid Retrieval -> LLM` đã có lát cắt chạy thật, nhưng metadata vẫn dùng JSON, ingestion chạy trong tiến trình Node.js và chưa có queue/DLQ production. Xem [Trạng thái triển khai](#trạng-thái-triển-khai) trước khi sử dụng với dữ liệu thật.

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
| Qdrant schema search | Khả dụng khi có Qdrant | Schema vẫn dùng vector deterministic 384 chiều |
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
QDRANT_COLLECTION=database_schema
QDRANT_VECTOR_SIZE=384
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
|       |-- knowledge_core/           # Library, Watch Folder và hybrid retrieval
|       |-- services/                 # SQL, Qdrant, provider, auth, logs...
|       `-- utils/storage_helper.js   # JSON persistence
|-- data/                             # Local runtime data; có thể chứa secret
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
| `GET` | `/api/dictionary` | Data Dictionary |
| `GET` | `/api/glossary` | Business Glossary |
| `POST` | `/api/qdrant/sync` | Đồng bộ schema sang Qdrant |
| `GET` | `/api/qdrant/status` | Trạng thái Qdrant |
| `POST` | `/api/intelligent-core/chat` | Agentic chat và tool calling |
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

Project có test nền tảng cho BM25, RRF, GraphRAG router và nhận diện file nguồn Watch Folder:

```powershell
npm test
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
- Một số API response provider có thể còn chứa cấu hình nhạy cảm.
- Password hiện hash SHA-256 không salt; chưa dùng Argon2id/bcrypt.
- Có tài khoản admin mặc định.
- Chưa có RBAC theo Library/folder/document.
- Chưa có CSRF protection hoàn chỉnh và cookie production hardening.
- SQL Connector phải sử dụng database account read-only riêng.
- Các file `data/*.json`, `.env`, archive và log có thể chứa secret hoặc dữ liệu nghiệp vụ.

Trước khi chia sẻ repo hoặc triển khai:

1. Rotate/revoke mọi API key từng lưu trong repo hoặc archive.
2. Không commit `.env` và `data/*.json` có dữ liệu thật.
3. Thay tài khoản/mật khẩu mặc định.
4. Giới hạn bind/firewall ở localhost hoặc mạng tin cậy.
5. Hoàn thành Security Gate trong kế hoạch Phase 1-2.

## Roadmap

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
