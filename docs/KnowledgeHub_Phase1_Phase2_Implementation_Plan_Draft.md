# KnowledgeHub - Kế hoạch hoàn thiện Phase 1 và Phase 2

**Trạng thái tài liệu:** Bản nháp để review  
**Ngày lập:** 06/08/2026  
**Nguồn đối chiếu:** `KnowledgeHub_Master_Plan_v3.docx` và mã nguồn hiện tại  
**Mục tiêu:** Đưa KnowledgeHub từ prototype hiện tại thành MVP RAG vận hành được ở Phase 1, sau đó nâng chất lượng truy xuất và độ ổn định ở Phase 2.

---

## 1. Kết luận điều hành

Hiện trạng dự án được xếp ở **Phase 1 - prototype**, với các phần mạnh là giao diện Vanilla JS, SQL Server Connector, Data Dictionary/Glossary, Text-to-SQL, AI Provider CRUD, chat/tool calling, API key và audit log cơ bản.

Phần còn thiếu để hoàn tất Phase 1 là pipeline tài liệu thật:

`Import file -> Validate/Deduplicate -> Parse -> Chunk -> Embed -> Index Qdrant -> Search -> Chat RAG -> Citation`

Sau khi pipeline trên đạt tiêu chí nghiệm thu, Phase 2 tập trung vào:

`Hybrid Search -> Reranker -> Summary/Related Documents -> Provider Fallback -> Evaluation -> Reliability`

Kế hoạch đề xuất gồm:

- **Phase 0 - Stabilization/Security Gate:** 1-2 tuần.
- **Phase 1 - Foundation MVP:** 6-8 tuần sau Phase 0.
- **Phase 2 - Search Quality:** 5-7 tuần sau khi Phase 1 được nghiệm thu.
- Tổng lịch mục tiêu: **12-17 tuần** với đội 3-4 người làm song song; **20-28 tuần** nếu một người thực hiện tuần tự.

Không chuyển trạng thái sang Phase 2 chỉ vì đã có UI hoặc route mang tên Phase 2. Phase 2 chỉ bắt đầu sau khi toàn bộ Definition of Done của Phase 1 đạt yêu cầu.

---

## 2. Nguyên tắc triển khai

1. **Không làm lại phần đang hoạt động tốt:** giữ UI Vanilla HTML/CSS/JS, SQL Connector, Dictionary, Glossary, security guard và intelligent core; refactor theo ranh giới module khi tích hợp.
2. **Không dùng dữ liệu giả cho trạng thái xử lý:** chunk count, trạng thái indexed, latency, token và chi phí phải lấy từ job hoặc dịch vụ thật.
3. **Metadata có hệ quản trị duy nhất:** PostgreSQL là nguồn dữ liệu chuẩn; JSON chỉ dùng cho migration tạm thời hoặc fixture phát triển.
4. **Mọi tác vụ nặng chạy bất đồng bộ:** parse, OCR, chunk, embed, re-index chạy qua BullMQ/Redis.
5. **File nhạy cảm không đi cloud:** sensitivity level được kiểm tra trước khi gọi AI provider.
6. **API versioning ngay từ phần mới:** endpoint mới dùng `/api/v1/...`; endpoint cũ được giữ qua lớp compatibility trong thời gian chuyển đổi.
7. **Có test và số đo trước khi tối ưu:** không tuyên bố Hybrid Search/Reranker tốt hơn nếu chưa có golden dataset và metric.
8. **UI thống nhất:** dùng Inter, Font Awesome và design token hiện có; mỗi trang có một JS module chính và lớp API dùng chung.

---

## 3. Phạm vi và kiến trúc mục tiêu

### 3.1 Thành phần mục tiêu cuối Phase 2

| Thành phần | Công nghệ | Trách nhiệm |
|---|---|---|
| Web UI | HTML/CSS/Vanilla JS | Library, Import jobs, Search, Chat, Providers, Evaluation, Admin |
| API Gateway | Node.js + Fastify | Auth, RBAC, REST API, orchestration, streaming response |
| AI/Document Service | Python + FastAPI | Parser, chunker, embedding, reranker, summary |
| Metadata DB | PostgreSQL | User, document, chunk metadata, jobs, providers, usage, audit |
| Vector DB | Qdrant | Vector BGE-M3 và payload filter |
| Queue | Redis + BullMQ | Import/retry/DLQ/re-embed jobs |
| Object/File Storage | Local volume có abstraction | File gốc và artifact trích xuất |
| LLM Gateway | Adapter layer hiện có, được nâng cấp | Task routing, fallback, sensitivity policy, usage |

### 3.2 Ngoài phạm vi Phase 1-2

- Knowledge Graph đầy đủ và Wiki editor.
- Multi-tenant enterprise, SSO và RBAC phân cấp tổ chức hoàn chỉnh.
- OCR production, cloud sync và audio/video transcription.
- Plugin marketplace/sandbox và Kubernetes.
- MCP Server production-grade; Phase 1-2 chỉ duy trì prototype và chuẩn bị contract.

---

## 4. Phase 0 - Stabilization và Security Gate

**Thời lượng:** 1-2 tuần  
**Mục tiêu:** Loại bỏ rủi ro cản trở phát triển và tạo baseline đo lường.

### P0.1 Quản lý secrets

- Revoke/rotate toàn bộ API key đang lưu trong `data/*.json` hoặc từng xuất hiện trong log/archive.
- Không trả `apiKey` plaintext từ API provider; chỉ trả `hasApiKey`, `lastFour` và masked value.
- Mã hóa secret at rest bằng AES-256-GCM; encryption key lấy từ environment/secret store, không lưu trong repo.
- Redact API key, password và connection string khỏi structured log.
- Bổ sung script kiểm tra secret trước commit/CI.

**Nghiệm thu:** Không còn secret plaintext trong file dữ liệu, response API, log mới và fixture.

### P0.2 Authentication và authorization tối thiểu

- Buộc đổi password admin mặc định ở lần đăng nhập đầu.
- Chuyển password hash sang Argon2id hoặc bcrypt có salt.
- Cookie có `HttpOnly`, `SameSite`, `Secure` ở production và rotation session.
- Thêm middleware `requireAuth`, `requireRole('admin')` cho AI Provider, API key, connector và system tools.
- Thêm CSRF protection cho mutation dùng cookie session hoặc chuyển API sang bearer access token.

**Nghiệm thu:** User thường không thể thêm/sửa/xóa provider, key hoặc nguồn SQL.

### P0.3 Baseline engineering

- Thêm ESLint/Prettier hoặc quy tắc tương đương.
- Thêm test runner cho Node và Python.
- Tạo cấu trúc `.env.example`; validate biến môi trường khi khởi động.
- Tạo health endpoints cho Node, Python, PostgreSQL, Redis và Qdrant.
- Thiết lập structured logging và correlation/request ID.
- Chốt API error envelope chung.

**Nghiệm thu:** CI chạy syntax/lint/unit test và không phụ thuộc dịch vụ ngoài cho unit test.

---

## 5. Phase 1 - Nền tảng MVP

**Thời lượng:** 6-8 tuần sau Phase 0  
**Exit goal:** Người dùng có thể nhập một tài liệu thật, theo dõi xử lý, tìm kiếm nội dung, hỏi đáp có citation và sử dụng local/cloud provider theo chính sách an toàn.

### Workstream P1-A - PostgreSQL Metadata Foundation

**Công việc**

- Thiết kế migration và schema tối thiểu:
  - `users`, `roles`, `user_roles`, `sessions`.
  - `libraries`, `folders`, `documents`, `document_versions`, `document_tags`.
  - `chunks`, `ingestion_jobs`, `job_attempts`, `dead_letter_jobs`.
  - `ai_providers`, `provider_models`, `provider_routing_rules`.
  - `llm_usage`, `audit_logs`, `api_keys`.
- Viết repository layer; service nghiệp vụ không đọc/ghi JSON trực tiếp.
- Viết migration một lần từ dữ liệu JSON hiện tại, có backup và rollback.
- Thêm transaction cho xóa document: metadata, chunks, vector và file artifact phải nhất quán hoặc có reconciliation job.

**Deliverable**

- Migration scripts và ERD.
- Repository/service contract.
- Tool import JSON -> PostgreSQL.

**Nghiệm thu**

- Restart không mất trạng thái.
- Migration chạy được trên database sạch và database có dữ liệu cũ.
- Không còn random `chunksCount` hoặc status giả.

### Workstream P1-B - Redis/BullMQ Ingestion Queue

**Công việc**

- Tạo queue: `document-import`, `document-parse`, `document-embed`, `document-delete`.
- Job có trạng thái `queued/running/succeeded/failed/cancelled/dead_letter`.
- Retry tối đa 3 lần với exponential backoff; lỗi không retry được chuyển DLQ.
- Idempotency key theo `document_version_id + pipeline_version`.
- UI hiển thị progress, bước hiện tại, lỗi có thể đọc và nút retry.
- Graceful shutdown và job recovery sau crash.

**Nghiệm thu**

- Restart worker giữa job không tạo duplicate chunks/vector.
- File lỗi xuất hiện trong DLQ, có thể retry sau khi sửa nguyên nhân.

### Workstream P1-C - File Import và Storage

**Loại file bắt buộc Phase 1**

- PDF text-based.
- DOCX.
- Markdown/TXT.
- XLSX/XLS/CSV.
- Source code ở mức extension whitelist.

**Công việc**

- Multipart upload thật, giới hạn dung lượng theo loại file.
- MIME sniffing; không tin extension từ client.
- Tính SHA-256 để phát hiện trùng nội dung.
- Lưu file gốc với tên vật lý an toàn; metadata giữ original filename.
- Versioning khi cùng tài liệu có nội dung mới.
- Quarantine file không hợp lệ; chống path traversal và zip bomb.
- API download/view file có permission check.

**Nghiệm thu**

- Upload file tạo record và job thật.
- File trùng không bị index lại ngoài ý muốn.
- Xóa tài liệu xóa/retire đủ file, metadata và vectors.

### Workstream P1-D - Parser Service

**Công việc**

- Tạo Python FastAPI service và interface parser chung.
- Mỗi parser trả về cấu trúc chuẩn:
  - text/block content.
  - page/sheet/section/heading.
  - table metadata.
  - source locator phục vụ citation.
- PDF giữ page number; DOCX giữ heading/paragraph/table; Excel giữ sheet/cell range; code giữ file path/symbol nếu xác định được.
- Chuẩn hóa UTF-8 và tiếng Việt; không làm mất dấu.
- Lưu parser version và parse artifact để tái lập.

**Nghiệm thu**

- Có unit test với file mẫu cho từng định dạng.
- Parser lỗi một file không làm worker crash.
- Citation locator được giữ xuyên suốt đến search result.

### Workstream P1-E - Chunking Strategy v1

**Công việc**

- Văn bản: semantic/heading-aware chunk, mục tiêu 300-500 token, overlap 10-20%.
- DOCX/PDF: không trộn heading/section không liên quan nếu tránh được.
- Table: giữ header với nhóm hàng và locator.
- Code: chunk theo function/class, fallback theo token window.
- Mỗi chunk có `chunk_index`, token count, content hash, locator và sensitivity level.
- Version hóa `chunking_strategy_version` để hỗ trợ re-index.

**Nghiệm thu**

- Không có chunk rỗng hoặc vượt hard token limit.
- Test tiếng Việt có dấu và boundary giữa trang/heading.
- Chunk có thể truy ngược về vị trí nguồn.

### Workstream P1-F - Embedding và Qdrant Production Path

**Công việc**

- Thay pseudo-vector hiện tại bằng BGE-M3 thật.
- Collection tài liệu tách khỏi collection SQL schema nếu payload/lifecycle khác nhau.
- Vector dimension lấy từ model config, không hard-code 384.
- Batch embedding, timeout, retry và rate/concurrency limit.
- Payload tối thiểu: tenant/user scope, library, document/version, chunk, source locator, sensitivity, tags, embedding version.
- Tạo alias cho collection để chuẩn bị zero-downtime re-embedding.
- Không xóa toàn collection khi cập nhật một tài liệu.

**Nghiệm thu**

- Tìm kiếm semantic trả về chunk của tài liệu vừa import.
- Re-import một document không nhân đôi point.
- Filter theo Library/document/sensitivity hoạt động đúng.

### Workstream P1-G - Basic Search và Chat RAG

**Công việc**

- API semantic search có query, filter, pagination/limit và relevance score.
- RAG pipeline v1: rewrite tối thiểu nếu cần -> vector retrieve -> context assembly -> LLM -> citation validation.
- Citation hiển thị document, page/sheet/heading/cell range và link mở nguồn.
- Không cho model tạo citation không tồn tại; response gắn citation ID từ retrieved chunks.
- Streaming token-by-token qua SSE.
- Cho phép chọn provider/model; mặc định theo routing rule.
- Khi không đủ evidence, trả lời rõ không tìm thấy thay vì suy đoán.

**Nghiệm thu**

- Bộ smoke test 20 câu có citation trỏ đúng nguồn.
- Không citation tới chunk ngoài tập retrieved.
- P95 semantic search dưới 1 giây trên dataset nghiệm thu cỡ nhỏ; RAG full response mục tiêu dưới 5 giây khi provider đáp ứng SLA.

### Workstream P1-H - AI Provider Manager v1

**Công việc**

- Chuẩn hóa provider adapter contract: models, chat, stream, health, usage/error mapping.
- Hoàn thiện local provider và tối thiểu một cloud provider.
- Hỗ trợ primary + fallback provider thật.
- Retry chỉ cho lỗi transient; không retry lỗi auth/quota cứng một cách vô hạn.
- Circuit breaker đơn giản và timeout riêng từng provider.
- Sensitivity rule: tài liệu `restricted` chỉ chạy local.
- Ghi usage thực từ provider; không dùng độ dài ký tự thay token.

**Nghiệm thu**

- Test tự động giả lập primary timeout và xác nhận chuyển fallback.
- Restricted content không xuất hiện trong request mock cloud.
- UI không bao giờ nhận API key plaintext.

### Workstream P1-I - Library/Import/Admin UI

**Công việc**

- Library hiển thị dữ liệu thật: size, version, status, chunk count, lỗi, updated time.
- Upload modal hỗ trợ progress và validation.
- Job monitor và DLQ view cơ bản.
- Search UI có snippet, source locator và relevance score.
- Chat UI có citation click-through và provider/model badge.
- Provider UI hiển thị masked secret, health và fallback order.
- Dùng API wrapper chung thay vì `fetch()` lặp lại rải rác.

**Nghiệm thu**

- Không còn KPI/status sinh ngẫu nhiên.
- Toàn bộ luồng import-search-chat thực hiện được từ UI không cần terminal.

### Workstream P1-J - Logging, Backup và Deployment

**Công việc**

- Docker Compose cho Node, Python, PostgreSQL, Redis và Qdrant.
- Healthcheck, startup dependency và named volume.
- Structured logs cho từng pipeline step với correlation ID.
- Metrics cơ bản: job count/error, queue depth, parse/embed latency, provider latency/error.
- Backup script cho PostgreSQL, Qdrant snapshot và file storage.
- Viết restore runbook và chạy restore drill một lần trước nghiệm thu.

**Nghiệm thu**

- Có thể dựng môi trường sạch bằng một quy trình được tài liệu hóa.
- Restore từ backup tạo lại được document metadata và search result.

---

## 6. Definition of Done - Phase 1

Phase 1 chỉ được đánh dấu hoàn thành khi tất cả điều kiện sau đạt:

- [ ] Upload ít nhất 5 định dạng bắt buộc và xử lý qua queue thật.
- [ ] Parser/chunker/embedding thật; không còn pseudo-vector trong production path.
- [ ] Qdrant index theo document lifecycle, không reset toàn collection khi sync một document.
- [ ] Semantic search trả snippet và locator đúng.
- [ ] Chat RAG có citation có thể mở về đúng page/sheet/section.
- [ ] Một local provider và một cloud fallback hoạt động thật.
- [ ] Sensitivity rule chặn restricted content ra cloud.
- [ ] PostgreSQL thay JSON làm metadata store chính.
- [ ] Redis/BullMQ có retry và DLQ.
- [ ] API key mã hóa, password hash an toàn, admin authorization được áp dụng.
- [ ] Có unit/integration test cho pipeline chính và security test Text-to-SQL.
- [ ] Có Docker Compose, backup và restore drill.
- [ ] Không còn số liệu/status giả trong Library, Watch Folder, Analytics và Provider usage.

---

## 7. Phase 2 - Chất lượng tìm kiếm và độ tin cậy

**Thời lượng:** 5-7 tuần  
**Điều kiện bắt đầu:** Phase 1 Definition of Done đạt 100%.  
**Exit goal:** Retrieval có thể đo lường, cải thiện được bằng hybrid/rerank, provider fallback ổn định và người vận hành biết chất lượng/chi phí thực.

### Workstream P2-A - Golden Dataset và Evaluation Harness

**Công việc**

- Xây 50-100 câu hỏi tiếng Việt từ dữ liệu thực đã được phép dùng.
- Mỗi câu có expected documents/chunks, answer key và citation expectation.
- Tạo CLI/CI job chạy retrieval evaluation.
- Metric: Recall@5/10, MRR, nDCG tùy dataset; citation precision/recall; groundedness/hallucination review.
- Lưu baseline theo embedding/chunking/reranker/prompt/provider version.

**Nghiệm thu**

- Mỗi thay đổi retrieval có báo cáo so sánh với baseline.
- CI cảnh báo hoặc chặn khi metric giảm quá ngưỡng được duyệt.

### Workstream P2-B - Hybrid Search

**Công việc**

- Bổ sung lexical index/BM25 phù hợp với tiếng Việt.
- Chạy vector và keyword retrieval song song.
- Fusion bằng RRF hoặc weighted score có config.
- Filter được áp dụng nhất quán ở cả hai nhánh.
- Search UI hiển thị normalized relevance, không trộn score khác thang trực tiếp.

**Nghiệm thu**

- Hybrid Search tăng Recall@10 so với semantic-only trên golden dataset theo ngưỡng chốt trước, đề xuất tối thiểu +5% tương đối.
- P95 search vẫn dưới 1 giây trên dataset nghiệm thu.

### Workstream P2-C - BGE Reranker

**Công việc**

- Retrieve top 30-50, rerank và chọn top 5-10 làm context.
- Batch inference, timeout và fallback về fused ranking khi reranker lỗi.
- Theo dõi rerank latency và model version.
- A/B test số lượng candidate/context budget.

**Nghiệm thu**

- MRR/nDCG tăng trên golden dataset mà latency vẫn trong budget.
- Reranker lỗi không làm search/RAG ngừng phục vụ.

### Workstream P2-D - Auto Summary và Related Documents

**Công việc**

- Summary chạy async sau index, có model/prompt version và regenerate action.
- Summary bắt buộc grounded trên chunks của chính document.
- Related Documents tính từ document centroid/representative chunks cộng metadata signals.
- Loại chính document, áp dụng permission filter và lưu lý do liên quan/snippet.

**Nghiệm thu**

- Summary có trạng thái và retry, không chặn import thành công.
- Related Documents không rò tài liệu người dùng không có quyền đọc.

### Workstream P2-E - Provider Routing, Fallback và Cost Dashboard

**Công việc**

- Routing profile theo task: RAG, Text-to-SQL, summary, complex reasoning, embedding/rerank.
- Priority chain, circuit breaker, cooldown và manual override.
- Budget/rate limit theo provider và task.
- Usage ledger: input/output/cache token, request, latency, error, estimated/actual cost.
- Dashboard theo ngày/provider/model/task; cảnh báo fallback bất thường hoặc vượt budget.

**Nghiệm thu**

- Chaos test provider timeout/429/5xx/auth error cho kết quả đúng policy.
- Chi phí dashboard đối chiếu được với usage response trong sai số cho phép.

### Workstream P2-F - Reliability và Data Quality

**Công việc**

- DLQ management hoàn chỉnh: filter, inspect, retry, dismiss, bulk action an toàn.
- Reconciliation job phát hiện document/chunk/vector lệch trạng thái.
- Zero-downtime re-embedding bằng collection mới và alias swap.
- Parser/chunker/embedding version migration.
- Alert khi queue nghẽn, error rate vượt ngưỡng hoặc provider liên tục fail.

**Nghiệm thu**

- Re-embed toàn bộ dataset mà search vẫn phục vụ.
- Reconciliation sửa hoặc báo cáo đầy đủ orphan/missing records.

### Workstream P2-G - Performance, Security và Release Hardening

**Công việc**

- Load test search, chat, batch import và provider gateway.
- Kiểm tra prompt injection, SQL injection, file upload abuse và authorization bypass.
- Giới hạn query timeout/row count; dùng SQL account read-only và TLS/encryption.
- Rate limit theo user/API key và ưu tiên interactive chat hơn batch job.
- Dependency/container scanning và release checklist.

**Nghiệm thu**

- Không có lỗ hổng Critical/High chưa có phương án được phê duyệt.
- Đạt performance budget đã chốt trên hạ tầng mục tiêu.

---

## 8. Definition of Done - Phase 2

- [ ] Golden dataset 50-100 câu và evaluation chạy được trong CI.
- [ ] Hybrid Search và Reranker chứng minh cải thiện metric so với baseline.
- [ ] Auto Summary và Related Documents hoạt động async, có permission filter.
- [ ] Routing/fallback chạy theo task, priority, circuit breaker và sensitivity policy.
- [ ] Dashboard có usage/token/cost thật theo provider/model/task.
- [ ] DLQ, reconciliation và zero-downtime re-embedding được kiểm thử.
- [ ] Load/security test đạt ngưỡng nghiệm thu.
- [ ] P95 Hybrid Search dưới 1 giây ở dataset/hardware nghiệm thu.
- [ ] RAG có tỷ lệ citation/groundedness đạt ngưỡng do product owner phê duyệt.
- [ ] Runbook vận hành, backup/restore và incident response được cập nhật.

---

## 9. Lịch triển khai đề xuất

### Phương án đội 3-4 người

| Tuần | Milestone | Kết quả bắt buộc |
|---|---|---|
| 1-2 | M0 - Secure baseline | Rotate secret, auth/admin guard, CI/test skeleton, architecture contract |
| 2-3 | M1 - Data foundation | PostgreSQL schema/migration, Redis/BullMQ, job model |
| 3-5 | M2 - Ingestion vertical slice | Upload PDF/DOCX -> parse -> chunk -> BGE-M3 -> Qdrant |
| 5-7 | M3 - Phase 1 usable MVP | Các parser còn lại, Library/job UI, semantic search, citation |
| 7-9 | M4 - Phase 1 release candidate | Chat RAG streaming, provider fallback, Docker/backup/test |
| 10 | Gate P1 | UAT và hoàn tất toàn bộ DoD Phase 1 |
| 11-12 | M5 - Evaluation baseline | Golden dataset, retrieval metrics, benchmark |
| 12-14 | M6 - Hybrid/Rerank | BM25/fusion, BGE reranker, performance tuning |
| 14-15 | M7 - Enrichment | Summary, Related Documents |
| 15-16 | M8 - Provider operations | Task routing, circuit breaker, usage/cost dashboard |
| 16-17 | Gate P2 | Chaos/load/security test, UAT và DoD Phase 2 |

Các tuần có thể chồng lấn nhưng milestone gate không được bỏ qua.

### Critical path

`Security baseline -> PostgreSQL/job model -> parser contract -> chunk locator -> embedding/Qdrant -> retrieval -> citation RAG -> golden dataset -> hybrid -> reranker`

Provider UI, analytics và deployment có thể chạy song song nhưng không được làm chậm critical path.

---

## 10. Phân công theo vai trò

| Vai trò | Trách nhiệm chính |
|---|---|
| Backend Node.js | Fastify/API, auth/RBAC, PostgreSQL repository, queue orchestration, provider gateway |
| AI/Python | Parser, chunker, BGE-M3, reranker, evaluation harness |
| Frontend | Library/import jobs, search, citation viewer, provider/evaluation dashboards |
| QA/DevOps | Test fixtures, integration/load/security test, Compose, CI, backup/restore |
| Product/Data Owner | Golden dataset, relevance judgment, citation acceptance, UAT |

Nếu đội ít người, ưu tiên theo critical path và hoãn polish dashboard cho tới khi vertical slice RAG chạy end-to-end.

---

## 11. Ma trận ưu tiên backlog

### P0 - Bắt buộc trước mọi release

- Secret rotation/encryption và API response masking.
- PostgreSQL metadata.
- Queue + DLQ.
- Parser/chunker/BGE-M3/Qdrant thật.
- Semantic search + citation RAG.
- Admin authorization và restricted-data routing.
- Automated tests cho critical path.

### P1 - Bắt buộc để kết thúc Phase 2

- Golden dataset/evaluation.
- Hybrid Search và reranker.
- Provider fallback/circuit breaker/cost ledger.
- Summary/Related Documents.
- Reconciliation và re-embedding không downtime.
- Load/security test.

### P2 - Có thể sau Phase 2 nếu trễ lịch

- Dashboard animation/polish không ảnh hưởng nghiệp vụ.
- Nhiều cloud provider ngoài một provider chuẩn OpenAI-compatible và một provider đặc thù.
- Search tuning nâng cao theo từng domain.
- MCP enhancements không phục vụ trực tiếp mục tiêu Phase 1-2.

---

## 12. Test plan tối thiểu

### Unit test

- Parser cho PDF/DOCX/Excel/Markdown/code.
- Chunk boundary, overlap, locator và tiếng Việt.
- Provider adapters và error normalization.
- SQL guard với SELECT/CTE, comment, multi-statement và từ khóa nguy hiểm.
- Permission/sensitivity policy.

### Integration test

- Upload -> queue -> parse -> chunk -> embed -> index -> search.
- Delete/re-import/version/retry/DLQ.
- Chat RAG -> retrieved chunks -> citation validation.
- Primary provider failure -> fallback.
- PostgreSQL/Qdrant reconciliation.

### Security test

- Path traversal, MIME spoof, zip bomb và oversized upload.
- API key exposure trong response/log.
- IDOR ở document/library/job/provider/API key.
- Prompt injection và Text-to-SQL bypass.
- Restricted content cloud egress test.

### Performance test

- Dataset chuẩn phải được chốt trước benchmark, đề xuất ban đầu: 10.000 tài liệu hoặc 250.000 chunks.
- Đo P50/P95/P99 cho semantic, hybrid, rerank và full RAG.
- Import batch, queue backlog và recovery sau worker crash.

---

## 13. Rủi ro chính và biện pháp

| Rủi ro | Tác động | Biện pháp |
|---|---|---|
| Tiếp tục mở rộng UI trước khi có pipeline thật | Cao | Gate mọi UI status bằng dữ liệu job/backend thật |
| Chuyển JSON sang PostgreSQL gây mất dữ liệu | Cao | Backup, migration idempotent, dry-run và rollback |
| Citation sai vị trí do parser làm mất locator | Cao | Parser contract và test locator từ đầu |
| BGE-M3/reranker chậm trên máy không GPU | Cao | Batch, concurrency cap, CPU profile và cloud/local deployment profiles |
| Fallback cloud làm rò dữ liệu | Rất cao | Sensitivity policy ở gateway, egress test và audit |
| Nhiều dịch vụ làm tăng độ phức tạp vận hành | Trung bình | Docker Compose, healthcheck, runbook và observability |
| Hybrid/rerank không cải thiện chất lượng | Trung bình | Golden dataset và metric gate trước khi release |
| Scope creep sang Wiki/Graph/MCP/Enterprise | Cao | Giữ danh sách out-of-scope và change-control |

---

## 14. Các quyết định cần chốt khi review

1. **Quy mô đội và lịch:** chọn lịch 12-17 tuần hay lịch một người 20-28 tuần.
2. **Môi trường mục tiêu:** Windows native, Docker Desktop hay Linux/NAS production.
3. **File storage:** local volume trước hay S3-compatible/MinIO ngay Phase 1.
4. **Lexical search Phase 2:** PostgreSQL Full Text Search, OpenSearch hoặc engine khác.
5. **Model deployment:** BGE-M3/reranker chạy CPU, GPU local hay inference service riêng.
6. **Ngưỡng quality gate:** Recall@10, MRR, citation precision và groundedness tối thiểu.
7. **Dataset benchmark:** số documents/chunks và hardware chuẩn để áp SLA.
8. **Chính sách retention:** soft delete, thời gian giữ file và thời gian xóa vector hoàn toàn.

---

## 15. Bước thực hiện ngay sau khi duyệt

1. Rotate secrets và đóng các endpoint quản trị bằng role admin.
2. Chốt ADR cho PostgreSQL schema, queue topology, parser contract và source locator.
3. Tạo vertical slice đầu tiên chỉ với PDF/DOCX:
   `upload -> job -> parse -> chunk -> BGE-M3 -> Qdrant -> search -> citation`.
4. Chỉ sau khi vertical slice pass integration test mới mở rộng Excel/code và làm lại Library UI.
5. Chạy Gate Phase 1 trước khi bắt đầu Hybrid Search/Reranker.

---

## 16. Quy ước trạng thái báo cáo

Mỗi hạng mục trong tracker dùng một trong các trạng thái:

- `Not started`: chưa có code hoặc spec được duyệt.
- `Prototype`: có UI/mock/route nhưng chưa dùng dữ liệu thật hoặc chưa có test.
- `In progress`: đang triển khai, chưa đạt acceptance criteria.
- `Ready for QA`: đã hoàn thành code và automated test, chờ UAT/integration gate.
- `Done`: đạt toàn bộ acceptance criteria, có bằng chứng test và tài liệu vận hành cần thiết.
- `Blocked`: có blocker cụ thể, owner và ngày xử lý dự kiến.

Không dùng `% hoàn thành` nếu không gắn với deliverable và acceptance criteria cụ thể.

---

## 17. Đánh giá lại backend chat và kế hoạch tối ưu (2026-08-16)

### 17.1. Phạm vi rà soát

Đánh giá này đối chiếu trực tiếp các luồng `/api/intelligent-core/chat`, `/api/embed/chat`, `/api/chat`, `/api/v1/chat/completions` và các thành phần `IntelligentCore`, `AgentHarness`, provider adapters, schema context, retrieval, tool manager, SQL connector, conversation memory và chat audit.

Luồng chính hiện tại:

`HTTP request -> auth/session -> conversation memory -> scope/schema/knowledge routing -> provider dispatch -> agentic tool loop -> SQL/knowledge tools -> final synthesis -> masking -> audit + memory -> HTTP response`

### 17.2. Điểm đang làm tốt

- Có schema context động, giới hạn số bảng/cột và bước model table selector khi độ tin cậy lexical thấp.
- Knowledge routing không chạy cho mọi câu hỏi; retrieval đã có dense + BM25 + graph heuristic + RRF và reranker tùy chọn.
- Agent Harness có provider fallback có phân loại lỗi, token collector, SQL retry budget và fingerprint chống lặp.
- SQL tool chạy qua guard read-only, tài khoản CSDL read-only và giới hạn kết quả cơ bản.
- Response contract đã tách reply, SQL, bảng kết quả, chart, token usage, fallback và context selection.
- Có conversation memory, audit, feedback và masking đầu ra cơ bản.

### 17.3. Phát hiện cần xử lý

| Mức | Phát hiện từ mã hiện tại | Tác động | Hướng xử lý |
|---|---|---|---|
| P0 | Có bốn endpoint chat dùng pipeline/contract khác nhau; `/api/v1/chat/completions` vẫn gọi `text2sql_agent` legacy | Chất lượng, guardrail, memory và fallback không đồng nhất | Chuẩn hóa một `ChatOrchestrator`; mọi endpoint chỉ là adapter vào cùng pipeline |
| P0 | Route chat không truyền quyền của tài khoản vào core; core mặc định `permissions: ['*']` | Mọi user đăng nhập có thể được cấp toàn bộ tool | Map role/account thành permission cụ thể; mặc định deny; embed chỉ có allowlist tool riêng |
| P0 | `securityGuard.validateInput()` tồn tại nhưng không được gọi trong luồng chính | Prompt injection trực tiếp không đi qua lớp kiểm tra đã thiết kế | Gọi input policy trước retrieval/provider; bổ sung policy cho prompt injection gián tiếp từ tài liệu |
| P0 | `aiProviderManager.getProviders()` dùng spread nên vẫn chứa `apiKey` thô trong response quản trị | Rò rỉ secret qua API/browser/log | Tách `getRuntimeProvider(s)` và `getPublicProvider(s)`; không bao giờ serialize secret |
| P0 | Mật khẩu DB và provider key vẫn lưu plaintext trong JSON | Lộ toàn bộ credential nếu file/log/backup bị đọc | Secret store hoặc mã hóa envelope; migration, rotation và redaction test |
| P0 | Schema context lấy tất cả bảng active, trong khi SQL execution dùng DB mặc định | Model có thể sinh SQL cho bảng thuộc DB khác | Truyền `dbSourceId` xuyên suốt request; filter dictionary/schema theo DB được chọn; ghi DB vào audit |
| P0 | SQL guard dựa trên regex/blacklist; chưa có parser AST, cost guard hay cancel truy vấn thật | Có thể lọt truy vấn read-only nhưng rất nặng hoặc biến thể nguy hiểm | Dùng T-SQL parser/allowlist AST, statement timeout, row/byte cap, khóa catalog và DB user read-only |
| P0 | `readJsonBody` không giới hạn kích thước; chưa thấy rate limit/concurrency limit cho chat và embed public | Memory exhaustion, abuse và tăng chi phí LLM | Body limit, per-user/IP rate limit, max concurrent requests, quota và backpressure |
| P1 | Retrieval dựng corpus, đọc nội dung và chunk lại toàn bộ tài liệu trên mỗi câu hỏi | Latency/CPU tăng tuyến tính theo thư viện | Persist chunks/BM25 index; cache theo document version; filter dense ngay tại Qdrant |
| P1 | Schema retrieval rồi knowledge retrieval chạy tuần tự | Tăng time-to-first-token | Chạy song song sau intent routing; cache schema context theo query fingerprint + schema version |
| P1 | Mỗi SQL query mở kết nối Tedious mới | Tốn handshake và dễ quá tải SQL Server | Connection pool theo `dbSourceId`, health check, max pool size và idle eviction |
| P1 | Timeout 45 giây của `AgentHarness` được khai báo nhưng không dùng làm deadline tổng; timeout provider áp dụng lại cho từng provider và từng vòng | Một request có thể kéo dài nhiều phút | Deadline tổng xuyên suốt bằng `AbortSignal`; chia ngân sách cho retrieval/LLM/tool/final synthesis |
| P1 | Tool calls trong cùng một turn chạy tuần tự | Lãng phí thời gian với các tool độc lập | Lập execution plan; chỉ chạy song song tool read-only, không phụ thuộc và có cùng policy scope |
| P1 | Kết quả tool được JSON stringify toàn bộ đưa lại vào prompt | Token/cost/context có thể phình lớn | Giới hạn rows, bytes và cell length; tạo compact tool result + artifact reference |
| P1 | `StorageHelper` dùng `readFileSync/writeFileSync`; audit và memory ghi nhiều file trên mỗi lượt chat | Block event loop, race/lost update khi có concurrency | Chuyển PostgreSQL/SQLite hoặc async append queue; batch audit và memory writes |
| P1 | Trace từ Agent Harness được tạo nhưng `_buildSuccessResponse` không nhận/trả trace | Mất dữ liệu phân tích bottleneck | Chuẩn hóa trace/span ID, trả debug trace có kiểm soát và lưu step latency |
| P1 | Memory summary chỉ nối và cắt chuỗi; session ID chưa ràng buộc với account/tenant | Mất ngữ nghĩa và có nguy cơ chạm session giữa user | Key `(tenantId, accountId, sessionId)`, TTL, optimistic locking và semantic summary |
| P1 | Provider fallback chưa có circuit breaker/cooldown; cùng provider lỗi có thể bị thử lại ở mọi vòng agent | Tăng latency và tạo retry storm | Circuit breaker theo provider/model, exponential backoff + jitter và health score |
| P2 | Citation mới dừng ở tên tài liệu/đoạn trong prompt, chưa có citation object được xác minh | Khó kiểm chứng grounding trên UI | Trả citation ID, document ID, chunk index, locator và quote span; citation validator |
| P2 | Tham số `model` từ request chat được đọc nhưng không sử dụng | API gây hiểu nhầm | Loại bỏ hoặc map rõ sang provider/model policy có kiểm soát |
| P2 | Chưa có streaming response | UX chậm dù backend đang xử lý | SSE/WebSocket với event `routing`, `tool_start`, `tool_result`, `token`, `done` |

### 17.4. Kiến trúc đích đề xuất

Tạo một `ChatOrchestrator` duy nhất với các stage có contract rõ ràng:

1. `RequestGuard`: xác thực, tenant/account/session binding, body limit, rate limit, permission và input policy.
2. `ContextRouter`: phân loại general/data/knowledge/mixed; chốt `dbSourceId`, `knowledgeSourceIds` và sensitivity.
3. `ContextBuilder`: schema và knowledge retrieval song song, có versioned cache và token budget.
4. `ProviderPolicy`: chọn model theo capability, sensitivity, health, latency và cost; cấm cloud egress khi policy không cho phép.
5. `AgentRuntime`: deadline tổng, iteration/tool/token/cost budget, idempotency key và cancellation.
6. `ToolGateway`: permission mặc định deny, schema validation, DB/source scope, result byte cap và audit riêng cho mỗi tool.
7. `ResponseComposer`: synthesis, citation validation, sensitive-data policy và contract thống nhất.
8. `TelemetrySink`: trace ID, stage latency, token/cost, retrieval quality, SQL stats, fallback reason và feedback link.

Các endpoint hiện hữu chuyển thành adapter:

- `/api/intelligent-core/chat`: contract nội bộ đầy đủ.
- `/api/embed/chat`: cùng orchestrator nhưng policy/tool/source bị giới hạn bởi embed config.
- `/api/v1/chat/completions`: adapter OpenAI-compatible, không gọi pipeline legacy.
- `/api/chat`: deprecate có telemetry; xóa sau một chu kỳ tương thích.

### 17.5. Kế hoạch triển khai theo lát cắt

#### Slice A — P0 Security và tính đúng đắn (3-5 ngày)

- Tách public/runtime provider DTO và che toàn bộ secret.
- Truyền account permissions vào core; bỏ wildcard mặc định.
- Gắn `dbSourceId` vào schema selection, SQL tool và audit.
- Bật input policy và retrieved-content isolation.
- Thêm request size/rate/concurrency limit.
- Bổ sung test secret exposure, permission denial, cross-DB isolation và prompt injection.

Acceptance criteria:

- Không endpoint nào trả `apiKey/password` thô.
- User thiếu `sql:read` không thấy và không gọi được SQL tool.
- SQL chỉ dùng schema và connection của đúng `dbSourceId`.
- Request quá giới hạn trả `413`; vượt quota trả `429`.
- Test injection trực tiếp và gián tiếp không thể làm lộ system prompt/secret hoặc gọi tool ngoài quyền.

#### Slice B — Hợp nhất pipeline và deadline (4-6 ngày)

- Tạo `ChatOrchestrator` và chuyển bốn endpoint sang cùng pipeline.
- Chuẩn hóa response/error/fallback/audit contract.
- Deadline tổng và abort propagation qua retrieval, provider, tool và SQL.
- Circuit breaker/cooldown provider; giới hạn tổng iteration, LLM calls, tool calls, token và cost.
- Persist trace theo stage; sửa đường truyền trace từ Agent Harness.

Acceptance criteria:

- Cùng input/policy cho kết quả tương đương trên mọi endpoint adapter.
- Không request nào vượt deadline cấu hình quá grace period 2 giây.
- Provider đang open-circuit không bị gọi lại trước cooldown.
- Audit luôn có trace ID, DB source, provider attempts, token/cost và latency từng stage.

#### Slice C — Hiệu năng retrieval, SQL và persistence (5-8 ngày)

- Persist chunk/BM25 index và cache theo document version.
- Chạy schema/knowledge retrieval song song; Qdrant server-side filter.
- SQL connection pool theo nguồn mặc định/được chọn.
- Compact tool result và giới hạn row/byte/cell.
- Thay JSON sync write bằng persistence async có transaction/concurrency control.

Acceptance criteria:

- Không đọc/chunk toàn thư viện trong hot path chat.
- P95 context building giảm tối thiểu 40% trên benchmark đã chốt.
- Không tạo connection SQL mới cho mỗi query khi pool còn khỏe.
- Event loop lag P95 dưới 50 ms ở tải mục tiêu.
- Không mất audit/memory khi chạy concurrent chat test.

#### Slice D — Chất lượng, citation và streaming (4-7 ngày)

- Citation object + validator và groundedness checks.
- Semantic memory summary có tenant/session isolation và TTL.
- SSE streaming theo stage.
- Golden dataset cho general chat, RAG, Text-to-SQL, multi-turn và provider fallback.

Acceptance criteria:

- Citation precision đạt ngưỡng quality gate đã duyệt.
- Text-to-SQL execution accuracy và schema selection recall được đo tự động.
- Streaming có thể cancel từ client và giải phóng provider/tool/SQL resource.
- Regression suite chạy được trong CI và lưu lịch sử metric.

### 17.6. Bộ chỉ số bắt buộc trước và sau tối ưu

- Latency: P50/P95/P99 tổng và theo stage; time-to-first-token nếu streaming.
- Reliability: success rate, timeout rate, fallback rate, SQL retry rate, circuit-open count.
- Cost: input/output tokens, số LLM calls, cost/request theo provider và route.
- Retrieval: Recall@K, MRR/nDCG, rerank uplift, context precision, empty-result rate.
- Text-to-SQL: schema selection recall, valid SQL rate, execution success, result correctness và query duration.
- Security: denied tool calls, injection detections, cross-source violations và secret-redaction failures.
- Capacity: active chats, queue depth, event-loop lag, memory, DB pool utilization và Qdrant latency.

### 17.7. Thứ tự khuyến nghị

Không tối ưu streaming hoặc UI trước khi hoàn tất Slice A. Critical path đề xuất là:

`secret/permission/source isolation -> unified orchestrator -> total deadline/circuit breaker -> retrieval + SQL pool -> async persistence -> citation/eval -> streaming`

Trạng thái đánh giá hiện tại: `Reviewed — implementation not started`. Mọi hạng mục chỉ chuyển sang `Ready for QA` khi có automated test tương ứng và benchmark trước/sau.
