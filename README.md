# KnowledgeHub AI

KnowledgeHub AI là nền tảng tri thức self-hosted đang được phát triển bằng Node.js và Vanilla HTML/CSS/JavaScript. Phiên bản hiện tại tập trung vào quản lý tri thức từ SQL Server, Data Dictionary, Business Glossary, Text-to-SQL, chat đa nhà cung cấp AI và các công cụ phân tích dữ liệu.

> **Trạng thái:** MVP đang phát triển. Runtime dữ liệu ứng dụng đã chuyển sang PostgreSQL, gồm auth, cấu hình, chat/memory/audit và metadata tài liệu. Ingest/delete tài liệu có outbox PostgreSQL, retry và worker lease; chưa triển khai Redis/BullMQ hoặc parser service riêng. Xem [biên bản chuyển dữ liệu](docs/POSTGRESQL_IMPORT_STATUS_180926.md) và [Trạng thái triển khai](#trạng-thái-triển-khai).

README đối chiếu với mã nguồn ngày **18/09/2026**. Trạng thái dưới đây mô tả chức năng đã triển khai; kết nối SQL, model, Qdrant và MCP thực tế phụ thuộc cấu hình của từng máy.

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
- Provider bên thứ ba dùng guarded harness khi `AI_PROVIDER_GUARDS_ENABLED=true`: kiểm tra tool/SQL/kết quả, repair có giới hạn, context budget và deadline. Page chat, modal và embed dùng chung luồng backend.
- Gate `SUCCESS/PARTIAL`: PARTIAL có thể hiển thị kèm trạng thái nhưng không vào memory thành công hoặc history SUCCESS gửi cho lượt tiếp theo. Memory do ứng dụng quản lý, không giao provider tự quyết định ghi nhớ.
- Lịch sử giao diện page chat lưu riêng trong PostgreSQL theo account, có version chống ghi đè giữa thiết bị; localStorage chỉ giữ tùy chọn và ID phiên đang mở. Nhập lịch sử trình duyệt cũ cần xác nhận quyền sở hữu.
- Che đường dẫn hệ thống trong câu trả lời của page/modal/embed; giữ link tải hợp lệ qua `/api/exports/...`.
- `skill_core`: chọn contract `record_lookup` hoặc `aggregate_report` theo request plan; hỗ trợ few-shot tương thích với schema và được kiểm soát bằng feature flag.
- Request budget dùng chung cho model call, SQL attempt và deadline; truyền abort signal xuống SQL connector.
- Memory Core: phân loại follow-up/chủ đề, lưu references và kiểm tra chất lượng trước khi ghi nhớ hội thoại.
- Streaming tiến trình qua `/api/intelligent-core/chat/stream`, gồm sự kiện tiến trình và kết quả cuối; không đồng nghĩa streaming token đầy đủ.
- Training Core: thu thập case, đánh giá SQL/câu trả lời, phân loại lỗi và tạo đề xuất cải tiến; chưa phải hệ thống fine-tuning model.
- Workflow engine: thực thi bước tự động, điều kiện, retry và trace; tab Workflow Automation hiện tạm ẩn trên giao diện.
- Training Core có tab Skills để sửa hướng dẫn, bật/tắt skill và chọn ví dụ; cấu hình lưu PostgreSQL khi dùng backend `postgres`.
- Memory Core v2 có pending turn, context budget, summary và semantic routing; các cờ v2 mặc định tắt trong `.env.example`.

### API và quản trị

- Giao diện dashboard bằng HTML/CSS/JavaScript thuần, không có build step frontend.
- Session authentication và tài khoản có role.
- Menu Tài khoản có đổi mật khẩu: xác minh mật khẩu hiện tại, băm scrypt, thu hồi mọi phiên của account và yêu cầu đăng nhập lại. Trang đăng nhập không hiển thị mật khẩu mặc định.
- API key nội bộ, embed-chat configuration và endpoint OpenAI-compatible cơ bản.
- System logs, chat audit, analytics và system tools. Lịch sử chat có cột nguồn (Page Chat, Embed Chat, API); log xử lý chat được lọc khỏi System Logs.
- Library hỗ trợ upload, parse PDF/DOCX/XLSX/CSV/TXT/SQL/Markdown, chunk, index, preview và xóa tài liệu.
- Watch Folder theo dõi filesystem thật, quét file ban đầu, chống trùng bằng `sourcePath` + SHA-256 và cập nhật lại document khi file đổi.
- UI Chat hiển thị mode retrieval, RRF/reranker, số chunk và nguồn tài liệu.
- MCP client kết nối server qua stdio, Streamable HTTP hoặc SSE; có handshake, discovery tools/resources và thực thi tool qua Agent Core/registry.
- Embed Chat hiển thị bảng Markdown, biểu đồ, link xuất file; hỗ trợ `data-theme="auto|light|dark"` và preview theo Embed ID từ trang quản trị.

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
| MCP Sources | Đã triển khai kết nối thật | SDK MCP, handshake/discovery/execution; cần khai báo server riêng, test stdio không chứng minh mọi server bên ngoài tương thích |
| Embed Chat | Đã triển khai | Endpoint JSON, domain allowlist, giới hạn theo cấu hình; admin preview bỏ kiểm tra domain |
| Skill editor | Đã triển khai | Sửa hướng dẫn và ví dụ trên UI; hiệu lực xử lý phụ thuộc feature flag |
| Memory Core v2 | Triển khai theo feature flag | Các cờ pending turn/budget/summary/semantic routing mặc định tắt trong cấu hình mẫu |
| Workflow Automation | Backend có, tab tạm ẩn | Chưa đưa lại vào điều hướng UI |
| PostgreSQL app storage | Đã cutover | Schema `app`, migration 001–003; dữ liệu JSON hiện có đã nhập/đối soát, runtime không tự fallback về JSON |
| Document outbox | Đã triển khai | PostgreSQL jobs, retry, lease và recovery; tác động file/Qdrant vẫn cần reconciliation |
| Redis/BullMQ | Chưa triển khai | Outbox hiện chạy trong Node.js, chưa có worker service riêng |
| Page chat history | Đã triển khai | Bảng `app.ui_chat_sessions`, owner account, mã hóa và kiểm tra version |
| Tải dữ liệu theo tab | Đã tối ưu bước đầu | API đọc các store cần thiết; MCP/tools bỏ gọi trùng; chưa phân trang audit hoặc benchmark tải lớn |
| Document Hybrid Search | Đã triển khai, phụ thuộc dịch vụ | BGE-M3 dense + BM25 + RRF; khi BGE-M3 lỗi vẫn tra cứu BM25 nhưng chất lượng semantic giảm |
| BGE Reranker | Sẵn sàng tích hợp | Bật bằng `RERANKER_ENABLED=true` khi reranker HTTP hoạt động |
| GraphRAG | Bản router/graph retrieval nền tảng | Chỉ kích hoạt cho câu hỏi quan hệ; chưa có persistent knowledge graph/community summary |

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

# System log retention (the selected storage backend applies)
MAX_CHAT_HISTORY=5000

# Memory Core v2: bật theo nhu cầu sau khi kiểm tra
MEMORY_PENDING_TURN_ENABLED=false
MEMORY_CONTEXT_BUDGET_ENABLED=false
MEMORY_SUMMARY_ENABLED=false
MEMORY_SEMANTIC_ROUTING_ENABLED=false

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
docker compose --env-file .env.postgres -f compose.postgres.yml up -d postgres
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

Nếu đã tự khởi động các dịch vụ phụ trợ, có thể chạy trực tiếp bằng `npm run dev` hoặc `node server.js`; cách này không gọi script PowerShell khởi động Ollama/Qdrant.

Trên Windows, `npm start` gọi `scripts/start-local.ps1` và tự động:

1. Đọc `.env` và `.env.postgres`, giữ ưu tiên biến môi trường đã có.
2. Khi backend là PostgreSQL cục bộ: kiểm tra Docker, mở Docker Desktop nếu cần, bật hoặc tạo container từ Compose và chờ database sẵn sàng. PostgreSQL remote bỏ bước Docker cục bộ. Bước này không tự chạy migration/import.
3. Khởi động Ollama native nếu API `11434` chưa hoạt động.
4. Tải `EMBEDDING_MODEL` nếu model chưa có trên máy.
5. Warm-up endpoint embedding để model sẵn sàng trước khi nhận tài liệu.
6. Kiểm tra/bật container `knowledgehub-qdrant` (Qdrant 1.18.3), tạo qua Compose stack `ai-project` nếu chưa có, và chờ API sẵn sàng. Không dùng `QDRANT_EXE`; Qdrant remote chỉ kiểm tra API.
7. Kiểm tra/tải local chat model (`LOCAL_AI_MODEL`, mặc định trong script là `qwen3.5:9b`) và chạy KnowledgeHub qua supervisor. `[Startup] Completed.` chỉ in sau HTTP listen thành công.

Các lần chạy sau không tải lại model vì Ollama đã lưu model cục bộ. Nếu Ollama hoặc Qdrant đã chạy, script chỉ kiểm tra và sử dụng tiến trình hiện có.

Mở:

- Dashboard: <http://localhost:3000>
- Login: <http://localhost:3000/login.html>

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

Tại **Nguồn MCP Server**, thêm endpoint HTTP/SSE hoặc command stdio. Hệ thống thử kết nối, lấy tools/resources và đăng ký tools vào luồng agent; dùng nút **Kết nối** để thử lại khi lỗi. Cấu hình lưu trong `data/mcp_servers.json`. Đây là MCP client kết nối dịch vụ ngoài, không phải endpoint MCP server do KnowledgeHub tự cung cấp. Khả năng gọi tool còn phụ thuộc model, quyền và trạng thái server.

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
  |-- MCP Client ---------------> MCP servers (stdio/HTTP/SSE)
  `-- Async Storage -------------> PostgreSQL app schema + document outbox
```

Backend dùng `node:http`, chưa dùng Fastify. Dữ liệu ứng dụng lưu PostgreSQL qua `storage.run/flush` bất đồng bộ; service thao tác view riêng từng operation. Commit hợp nhất thay đổi theo record trong transaction ngắn. HTTP success/cookie và SSE final chỉ gửi sau commit; progress SSE vẫn truyền khi xử lý. File tài liệu/export ở filesystem, dữ liệu nghiệp vụ ở SQL Server, vector ở Qdrant. Redis/BullMQ và parser/embedding Python service vẫn là định hướng.

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
|       |-- storage/                  # Async operation scope, PostgreSQL repository/outbox
|       `-- utils/storage_helper.js   # Chuyển loadJson/saveJson sang storage theo backend
|-- migrations/postgres/              # SQL migration có checksum
|-- compose.postgres.yml              # PostgreSQL 18, named volume và healthcheck
|-- data/                             # File tài liệu/export và JSON legacy giữ làm bản sao
|   `-- backup/                       # Backup migration cục bộ, không dùng ở runtime
|-- scripts/
|   `-- eval/                         # Semantic evaluator và logic benchmark
|-- docs/                             # Master plan và implementation plans
|-- .agents/                          # Quy tắc dành cho coding agents
|-- package.json
`-- .env.example
```

## API chính

API bổ sung: `POST /api/auth/change-password`, `GET/POST /api/page-chat/sessions`, `GET /health/live` và `GET /health/ready`. Readiness yêu cầu schema 3, database live và account; PostgreSQL lỗi không tự ghi về JSON.

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
| `GET` | `/api/training/skills` | Danh sách skill và trạng thái cấu hình |
| `POST` | `/api/training/skills/save` | Lưu chỉnh sửa skill |
| `GET` | `/api/mcp/servers` | Danh sách và trạng thái MCP |
| `POST` | `/api/mcp/add` | Thêm và thử kết nối MCP |
| `POST` | `/api/mcp/connect` | Kết nối lại MCP theo ID |
| `POST` | `/api/mcp/delete` | Gỡ MCP server |
| `GET` | `/api/embed/configs` | Danh sách cấu hình Embed |
| `POST` | `/api/embed/chat` | Chat qua Embed ID; public có kiểm tra domain |
| `GET` | `/health/live`, `/health/ready` | Endpoint health cơ bản, không xác nhận mọi dịch vụ phụ trợ |

Xem trang **API & SDK** trong dashboard để tạo API key và cấu hình embed chat. Endpoint `/api/v1/chat/completions` hiện chỉ tương thích một phần với OpenAI API; chưa hỗ trợ đầy đủ streaming và toàn bộ tham số chuẩn.

## Kiểm tra mã nguồn

Kiểm tra gần nhất: **202 test ứng dụng đạt**, hai nhóm PostgreSQL chạy riêng; **33 test PostgreSQL thật đạt** trong database tạm. Bao phủ import/rollback/encryption, concurrency, auth/đổi mật khẩu, page history, scope API từng tab, HTTP/SSE commit gate, outbox và quyền runtime. Test chat/ingest dùng core/Qdrant giả lập; không thay thế kiểm thử provider tính phí, SQL nghiệp vụ và retrieval thật.

```powershell
npm run test:storage
npm run eval:provider
```

Đã đo thời gian snapshot từng tab trên dữ liệu hiện tại, chưa phải thời gian tải trang end-to-end hoặc p95 tải lớn. Xem [biên bản hiệu năng](docs/PAGE_LOAD_PERFORMANCE_180926.md).

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
npm run eval:memory                   # đánh giá Memory Core
npm run eval:sql                      # SQL security corpus
npm run benchmark:http               # benchmark HTTP
npm run backup                       # backup dữ liệu
npm run restore -- <backup-path>      # xem yêu cầu/tham số trong scripts/backup_restore.js
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

- Credential trên PostgreSQL dùng AES-256-GCM với context record; token/API key có hash lookup. JSON legacy và snapshot cũ có thể vẫn chứa secret, cần bảo vệ như dữ liệu nhạy cảm.
- DTO provider không trả API key gốc; credential thực thi chỉ được đọc trong backend.
- Password tài khoản mới dùng scrypt; hash SHA-256 cũ được nâng cấp sau lần đăng nhập hợp lệ.
- Admin được bootstrap bằng `BOOTSTRAP_ADMIN_PASSWORD`; dữ liệu cũ có thể vẫn chứa tài khoản/mật khẩu từ bản trước.
- Chưa có RBAC theo Library/folder/document.
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

Restore chỉ tạo database mới tên `knowledgehub_restore_*`, không ghi đè database live. Backup/restore đã được rehearsal và đối soát dữ liệu hiện tại. Export JSON legacy chưa bao gồm `ui_chat_sessions`; phục hồi đầy đủ cần database dump, file tài liệu và khóa mã hóa. Sau khi PostgreSQL đã nhận ghi mới, không đổi về JSON cũ hoặc chạy importer ghi đè. Volume Docker không thay thế backup; lịch backup tự động/PITR chưa được cấu hình.

Request chat có `X-Request-Id` cùng owner/path/body không nhân đôi memory/audit; receipt hiện kiểm tra lúc commit nên retry vẫn có thể gọi model/tool. Worker lease chống chạy đồng thời nhưng chưa cam kết exactly-once cho tác động ngoài database. Mutation/route chưa tối ưu vẫn có thể đọc snapshot đầy đủ; phân trang audit và tối ưu tải lớn còn trong backlog.

Trước khi chia sẻ repo hoặc triển khai:

1. Rotate/revoke mọi API key từng lưu trong repo hoặc archive.
2. Không commit `.env` và `data/*.json` có dữ liệu thật.
3. Thay tài khoản/mật khẩu mặc định.
4. Giới hạn bind/firewall ở localhost hoặc mạng tin cậy.
5. Hoàn thành Security Gate trong kế hoạch Phase 1-2.

## Roadmap

Thứ tự ưu tiên backend hiện tại: **bảo vệ secret/quyền và dữ liệu → ổn định vận hành/đo hiệu năng → chất lượng câu trả lời → mở rộng lưu trữ và worker**. Xem backlog BE-01–BE-11 và tiêu chí nghiệm thu trong [kế hoạch backend](docs/Backend_Review_Development_Plan-080926.md). Các Phase dưới đây là định hướng dài hạn, không phải chức năng đã hoàn thành.

### Phase 1 - Nền tảng MVP

- PostgreSQL app store đã triển khai; tiếp tục query theo domain/cursor, phân trang audit, benchmark p95 và giám sát pool/dung lượng.
- Redis/BullMQ ingestion queue và dead-letter queue.
- Hoàn thiện versioning tài liệu và transaction/reconciliation giữa metadata, file và vector.
- Nâng chunking hiện tại lên semantic/token-aware chunking có locator theo page/sheet/section.
- Hoàn thiện citation validation và khả năng mở đúng vị trí nguồn.
- Hoàn thiện sensitivity-aware routing và circuit breaker cho AI Provider.
- Docker Compose và mở rộng kiểm thử triển khai; script backup/restore và automated tests đã có trong repository.

### Phase 2 - Chất lượng tìm kiếm

- Mở rộng golden dataset và đưa retrieval evaluation vào CI.
- Vận hành BGE Reranker service và benchmark so với RRF baseline.
- Auto Summary và Related Documents.
- Provider routing, circuit breaker và cost dashboard.
- Zero-downtime re-embedding, load test và release hardening.

### Phase 3-4

- Phase 3: RBAC chi tiết, persistent Knowledge Graph, LLM entity/relation extraction, community summary, Wiki và mở rộng SDK/API. MCP client kết nối server ngoài đã triển khai.
- Phase 4: OCR, Cloud Sync, Multi-user, AI Agents, plugin sandbox và enterprise operations.

Phase 3-4 hiện mới ở mức roadmap; chưa có workflow/task manifest đủ chi tiết để giao tự động cho coding agents. Phase 5 chưa được định nghĩa trong master plan hiện hành.

## Tài liệu

- [Tích hợp PostgreSQL: kế hoạch và checklist](docs/POSTGRESQL_DATA_INTEGRATION_PLAN_180926.md)
- [Biên bản dữ liệu và runtime PostgreSQL](docs/POSTGRESQL_IMPORT_STATUS_180926.md)
- [Kiểm tra tải trang và dữ liệu từng tab](docs/PAGE_LOAD_PERFORMANCE_180926.md)
- [Tối ưu provider bên thứ ba](docs/THIRD_PARTY_PROVIDER_OPTIMIZATION_PLAN_170926.md)

- [Memory Core Upgrade v2](docs/MEMORY_CORE_UPGRADE_PLAN_v2_120926.md)
- [Skill Core Upgrade](docs/SKILL_CORE_UPGRADE_PLAN_120926.md)
- [Local Model Optimization v2](docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md)

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
