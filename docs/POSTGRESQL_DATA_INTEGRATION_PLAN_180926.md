# Kế hoạch tích hợp dữ liệu ứng dụng vào PostgreSQL

- Ngày lập: 18/09/2026.
- Trạng thái: Đã cutover runtime sang PostgreSQL và đối soát dữ liệu hiện tại. Xem [biên bản hoàn tất](POSTGRESQL_IMPORT_STATUS_180926.md).
- Dự án: KnowledgeHub AI.
- Mục tiêu: chuyển dữ liệu ứng dụng đang lưu bằng JSON sang PostgreSQL, giữ nguyên hành vi chat, memory, quản trị và kết nối dữ liệu nghiệp vụ.
- Triển khai dự kiến: PostgreSQL trong Docker; backend Node.js hiện tại có thể tiếp tục chạy trên Windows.

## 1. Phạm vi và quyết định kiến trúc

PostgreSQL sẽ là nơi lưu chính thức cho dữ liệu ứng dụng: tài khoản, cấu hình, phiên chat, memory, audit, workflow và metadata tài liệu. Dữ liệu hợp đồng/khách hàng trong SQL Server tiếp tục được truy vấn qua connector hiện có. Qdrant tiếp tục phục vụ tìm kiếm vector; file tài liệu và file export tiếp tục nằm trên filesystem, PostgreSQL lưu metadata và đường dẫn.

```text
Page chat / Modal chat / Embed / API / Workflow
                        ↓
                 Backend Node.js
                        ↓
               Service + Repository
          ┌─────────────┼─────────────┐
          ↓             ↓             ↓
     PostgreSQL     SQL Server      Qdrant
     App state      Nghiệp vụ       Vector index
          ↓
     Metadata tham chiếu tới file tài liệu/export
```

Các quyết định mặc định của kế hoạch:

1. Database ứng dụng: `knowledgehub_app`, schema dự kiến `app`.
2. Dùng driver `pg` và SQL migration có version; chưa bổ sung ORM để tránh thay đổi thêm mô hình code hiện tại.
3. Dùng bảng và cột riêng cho định danh, quan hệ, trạng thái, thời gian; dùng `jsonb` cho payload linh hoạt. Không lưu toàn bộ mỗi file JSON vào một hàng làm thiết kế đích.
4. Giữ ID hiện có dạng text để bảo toàn URL, feedback, lịch sử và tham chiếu. ID bản ghi mới dùng UUID do ứng dụng sinh; không tiếp tục phụ thuộc duy nhất vào `Date.now()`.
5. Mỗi nhóm dữ liệu chỉ có một nơi ghi chính tại một thời điểm. Cho phép chuyển từng nhóm, nhưng không dual-write JSON/PostgreSQL một cách tùy ý.
6. Không tự chuyển sang JSON khi PostgreSQL lỗi; trả lỗi có kiểm soát để tránh hai bản dữ liệu lệch nhau.
7. Backend quản lý memory cho cả local và provider bên thứ ba. Việc thêm model tóm tắt hội thoại là hạng mục khác.

## 2. Hiện trạng đã rà soát

`src/backend/utils/storage_helper.js` đọc JSON đồng bộ và ghi qua file tạm rồi rename. Cách ghi này hạn chế file bị ghi dở, nhưng không giải quyết việc nhiều process giữ bản sao cũ rồi ghi đè lẫn nhau.

Nhiều service nạp toàn bộ dữ liệu vào thuộc tính trong constructor và persist cả tập dữ liệu, như `ai_provider_manager`, `auth_service`, `logger_service`, `memory_service`, `dictionary_service`, `workflow_service` và `library_service`.

Các điểm phải đưa vào migration:

- `server.js` hiện require router/service trước khi HTTP server lắng nghe. Cần bootstrap bất đồng bộ và kiểm tra storage sẵn sàng.
- `routes/router.js` còn đường đọc trực tiếp `data/ai_persona.json`; không chỉ sửa `StorageHelper` là đủ.
- `training_core/case_collector.js` và các script đọc trực tiếp lịch sử/feedback từ file; cần chuyển sang repository hoặc chế độ import/export rõ ràng.
- `scripts/backup_restore.js` hiện chỉ sao chép thư mục dữ liệu; chưa backup PostgreSQL.
- History phía trình duyệt là dữ liệu phục vụ giao diện và context dự phòng; không thể mặc định rằng mọi lịch sử đó đã có đầy đủ trong backend.
- Chưa thấy Compose PostgreSQL trong repository tại thời điểm lập kế hoạch. Cần kiểm tra Docker Desktop/WSL 2 khi bắt đầu triển khai.

## 3. Danh mục dữ liệu và đích lưu

| Nguồn hiện tại | Đích PostgreSQL đề xuất | Ghi chú |
|---|---|---|
| `accounts.json` | `accounts` | Giữ password hash và quyền; không tái tạo admin khi import |
| `sessions.json` | `auth_sessions` | Phiên đăng nhập; tách khỏi phiên hội thoại |
| `api_keys.json` | `api_keys` | Giữ quyền/hạn dùng; xác minh key qua hash nếu luồng hiện tại cho phép |
| `db_sources.json` | `data_sources` | Chỉ cấu hình kết nối SQL Server và nguồn khác, không copy dữ liệu nghiệp vụ |
| `ai_providers.json` | `ai_providers` + thiết lập provider đang active | API format, khả năng tool, priority, context budget |
| `ai_persona.json` | `ai_personas` | Giữ contract API persona |
| `embed_chat_configs.json` | `embed_configs` | Origins, giới hạn và phạm vi embed |
| `mcp_servers.json` nếu có | `mcp_servers` | File được service hỗ trợ dù chưa có trong danh sách data hiện tại |
| `dictionary.json` | `dictionary_tables`, `dictionary_columns` | Giữ identity theo source/database/schema/table |
| `table_relationships.json` | `table_relationships` | Bảo toàn hai đầu quan hệ và cột liên kết |
| `glossary.json` | `glossary_terms` | Thuật ngữ nghiệp vụ |
| `domain_aliases.json` | `domain_aliases` | Một domain/alias trên một hàng; giữ chuẩn hóa hiện có |
| `skills.json` | `skills` | Định nghĩa linh hoạt bằng `jsonb`, có version |
| `chat_history.json` | `chat_runs`, `tool_executions` | Đây là audit theo lượt; không coi mọi bản ghi là memory hợp lệ |
| `chat_feedback.json` | `chat_feedback` | Liên kết audit ID, rating và review status |
| `conversation_memory.json` | `chat_sessions`, `chat_messages`, `memory_states` | Import riêng messages đã lưu, summary, references, pending turn |
| `logs.json` | `system_logs` | Phân trang và retention theo thời gian |
| `workflows.json` | `workflows` | Definition dạng `jsonb` |
| `workflow_runs.json` | `workflow_runs`, `workflow_steps` | Trạng thái, lần thử, thời gian và lỗi |
| `library.json` | `documents` | Metadata tài liệu; nội dung/file giữ trên storage hiện có |
| `watchfolders.json` | `watchfolders` | Đường dẫn và cấu hình quét |
| `watchfolder_logs.json` | `watchfolder_runs` | Theo dõi nhập liệu, lỗi và tiến độ |
| `training_resolutions.json` nếu có | `training_resolutions` | Trạng thái xử lý case; file được service tạo khi cần |
| `training/regression_cases.json` | `regression_cases` | Import corpus quản trị; tiếp tục hỗ trợ xuất fixture cho CI |

Các dữ liệu giữ ngoài PostgreSQL:

- `.env`, khóa mở mã hóa và thông tin bootstrap kết nối database.
- File tài liệu gốc, text đã trích xuất, file export, backup/snapshot.
- Vector trong Qdrant; fixtures trong `tests/fixtures` vẫn là dữ liệu kiểm thử.
- `data/backup/*.json` là bản lưu, không import như dữ liệu đang active.
- File mới phát sinh hoặc file không nằm trong manifest phải được báo cáo để phân loại, không bị bỏ qua âm thầm.

## 4. Docker và cấu hình kết nối

- [x] Tạo Compose riêng, dự kiến `compose.postgres.yml`, cho PostgreSQL 18; cố định patch tag hoặc digest đã kiểm thử trước khi phát hành, không dùng `latest`.
- [x] Dùng named volume gắn vào `/var/lib/postgresql` đối với image PostgreSQL 18. Đây là đường dẫn mount của image 18+, khác mặc định của 17 trở xuống. [Tài liệu image chính thức](https://github.com/docker-library/docs/blob/master/postgres/content.md)
- [x] Có healthcheck `pg_isready`, restart policy và hướng dẫn khởi động Docker Desktop trên Windows.
- [x] Backend chạy trên Windows kết nối port bind ở `127.0.0.1`; chọn port sau khi kiểm tra xung đột. Backend chạy trong Compose kết nối hostname của service PostgreSQL qua mạng nội bộ.
- [x] Tách tài khoản bootstrap, tài khoản chạy migration và tài khoản runtime. `POSTGRES_USER` của image tạo superuser, không dùng trực tiếp làm tài khoản ứng dụng. [Tài liệu biến môi trường](https://github.com/docker-library/docs/blob/master/postgres/content.md)
- [x] Thêm `.env.example` cho `APP_STORAGE_BACKEND`, các biến `APP_PG_*`, timeout và pool size; không đưa password thật vào Git hoặc log.
- [ ] Quy định dung lượng đĩa, nơi backup và cách restore volume/database. Không dùng thao tác xóa volume như cách khởi động lại.
- [x] Không dùng script khởi tạo container thay cho hệ thống schema migration: init script chỉ chạy khi data directory rỗng. [Hành vi khởi tạo image](https://github.com/docker-library/docs/blob/master/postgres/content.md)

Giá trị khởi đầu đề xuất: pool tối đa 10 kết nối cho mỗi process; statement timeout 10 giây cho truy vấn ứng dụng thông thường. Tổng pool phải tính theo số process/worker; migration và backup có giới hạn riêng. Chốt các giá trị qua đo tải, không coi đây là cấu hình tối ưu cho mọi máy.

## 5. Schema và nguyên tắc dữ liệu

### 5.1. Chat, audit và memory

| Bảng | Các trường chính đề xuất |
|---|---|
| `chat_sessions` | `id`, `owner_scope`, `client_session_id`, `account_id`, `embed_id`, `title`, `created_at`, `updated_at` |
| `chat_messages` | `id`, `session_id`, `run_id`, `sequence_no`, `role`, `content`, `scope`, `created_at` |
| `chat_runs` | `id`, `session_id` nullable, `request_id`, `question`, `reply`, `completion_status`, `provider_id` nullable, `model`, `token_usage`, `context_selection`, `diagnostics`, `started_at`, `finished_at` |
| `tool_executions` | `id`, `run_id`, `sequence_no`, `tool_name`, `success`, `duration_ms`, payload đã làm sạch |
| `memory_states` | `session_id`, `active_scope`, `last_plan`, `summary`, `references`, `pending_turn`, `version`, `updated_at` |
| `chat_feedback` | `id`, `run_id`, người đánh giá, rating, review status, ghi chú, thời gian |

- `owner_scope` phải không null và do server xác định: tài khoản, embed hoặc chủ thể phiên được cấp bởi server. Không tin account ID do client tự gửi.
- Unique `(owner_scope, client_session_id)` ngăn đọc chéo phiên. Không dùng riêng `client_session_id` làm khóa toàn cục.
- Unique `(session_id, sequence_no)` và `(run_id, sequence_no)` cho thứ tự ổn định; dùng row lock hoặc cơ chế cấp sequence theo transaction khi cập nhật cùng phiên.
- `auth_sessions` là bảng khác, không trộn cookie đăng nhập với chat session ID.
- Audit lưu cả `SUCCESS`, `PARTIAL`, `ERROR`; memory chỉ lưu trao đổi qua quality gate. Pending turn nằm riêng như hiện tại.
- Lưu hai message của một trao đổi thành công cùng cập nhật memory trong một transaction. Có idempotency key để retry không tạo hai lượt.
- Không tạo audit giả hoặc message trùng khi một lượt đã có trong cả `chat_history.json` và `conversation_memory.json`. Giữ nguồn import và chỉ nối hai bản ghi khi có bằng chứng chắc chắn.
- Chat audit cũ không rõ chủ sở hữu không được tự gán cho một người dùng hoặc đưa vào memory; giữ trong phạm vi lịch sử quản trị với session nullable.

### 5.2. Kiểu dữ liệu, index và tham chiếu

- Cột thời gian dùng `timestamptz`; API hiển thị theo `Asia/Saigon` khi cần.
- Timestamp cũ dạng `14:04:39 15/9/2026` phải được parse theo múi giờ đã biết, không dùng `Date.parse` tùy môi trường. Giữ chuỗi nguồn và đưa bản ghi không xác định vào báo cáo migration.
- ID cũ giữ dạng text. JSONB chỉ cho trường linh hoạt như plan, diagnostics, definition; trường truy vấn thường xuyên là cột riêng.
- Index ban đầu: messages theo `(session_id, sequence_no)`, audit theo `(owner_scope, started_at)` nếu scope được lưu trực tiếp hoặc qua join đã index; runs theo `(completion_status, started_at)`, feedback theo `run_id`, auth session theo token hash và `expires_at`.
- Unique dictionary identity theo source/database/schema/table đã chuẩn hóa; unique columns theo table và tên cột chuẩn hóa.
- Không thêm GIN cho mọi JSONB. Chỉ thêm sau khi xác định câu query cần dùng và kiểm tra query plan.
- Xóa một provider không làm mất audit: lưu snapshot tên/model và chọn FK nullable hoặc soft delete. Chính sách xóa từng loại dữ liệu phải được định nghĩa trước khi dùng cascade.
- Nội dung rows/tool payload lớn có giới hạn và retention; không biến audit thành bản sao toàn bộ dữ liệu nghiệp vụ.

### 5.3. Tài khoản và secrets

- Bảo toàn password hash hiện có, kể cả luồng nâng hash legacy sau đăng nhập. Không chuyển thành plaintext hoặc hash lại chuỗi hash.
- Session token dùng hash tra cứu; import token hiện tại bằng hash tương ứng và giữ hạn dùng, hoặc có kế hoạch buộc đăng nhập lại được ghi rõ trước cutover.
- API key được kiểm tra bằng hash nếu không cần khôi phục plaintext. Credential gọi provider/SQL Server cần đọc lại thì mã hóa ở tầng ứng dụng, khóa nằm ngoài database và backup dữ liệu.
- Không mã hóa lại các giá trị đã masked từ public DTO; migration phải lấy nguồn nội bộ đúng và không in secrets trong report.
- Tài khoản PostgreSQL của backend không được đưa vào danh sách database nghiệp vụ mà SQL tool có thể tùy ý truy vấn.

## 6. Refactor code và vòng đời kết nối

Các file/thư mục dự kiến bổ sung:

```text
src/backend/storage/
  index.js                 # Lựa chọn backend theo nhóm dữ liệu
  postgres/pool.js          # Pool, timeout, kiểm tra sẵn sàng, shutdown
  postgres/transactions.js  # Transaction trên cùng một client
  repositories/            # Contract theo domain, không theo tên file
  json/                    # Adapter tương thích trong thời gian migration
migrations/postgres/       # SQL schema migration có version/checksum
scripts/postgres/          # Preflight, import, verify, export, backup/restore
```

- [ ] Định nghĩa repository contract trước: `findById`, list có cursor, insert/update có version, transaction theo nghiệp vụ.
- [ ] Chuyển các service constructor sang nhận repository; không gọi database async trong constructor và không giữ cả database trong RAM làm nguồn chính.
- [x] Tạo `bootstrapStorage()` được await trước HTTP listen và trước watchfolder/workflow worker bắt đầu chạy.
- [x] Refactor route, tool/harness và script gọi service thành async khi cần; kiểm tra cả các hàm thuần đang phụ thuộc dictionary/provider đồng bộ.
- [x] Với dictionary/provider đọc nhiều: có thể dùng snapshot cache đã tải ở startup, nhưng phải quy định invalidation sau commit và refresh giữa nhiều process. Không persist lại toàn bộ snapshot để thực hiện một thay đổi nhỏ.
- [x] Cùng một transaction phải dùng cùng client lấy từ pool và luôn release trong `finally`. Không gọi `pool.query` rời rạc để giả lập một transaction. [Hướng dẫn node-postgres](https://node-postgres.com/features/transactions)
- [x] Không giữ transaction hoặc row lock trong thời gian chờ LLM, SQL Server, Qdrant hay ghi file lâu. Ghi trạng thái trước/sau bằng transaction ngắn.
- [x] `/health/live` phản ánh process; `/health/ready` kiểm tra PostgreSQL và version schema yêu cầu. PostgreSQL chưa sẵn sàng thì không nhận ghi app state như bình thường.
- [x] Shutdown ngừng nhận request/job mới, đợi công việc trong giới hạn, đóng pool. Lỗi ghi audit/memory phải được báo rõ, không phát trạng thái đã lưu khi chưa commit.
- [ ] Với workflow/watchfolder nhiều worker: claim job bằng lock/lease, có idempotency. Không để hai worker cùng xử lý một job từ snapshot RAM.

## 7. PostgreSQL, file và Qdrant

Không có transaction đơn giản bao trùm cả PostgreSQL, filesystem và Qdrant. Dùng trạng thái và job có thể retry:

1. Upload file vào đường dẫn tạm, tính checksum và kiểm tra tồn tại.
2. Ghi document metadata và một outbox job trong cùng transaction PostgreSQL.
3. Worker đưa file về vị trí chính thức, xử lý chunks và cập nhật Qdrant theo ID ổn định.
4. Chỉ đánh dấu document sẵn sàng sau khi hoàn tất; lỗi lưu trạng thái để retry.
5. Có job đối soát file mồ côi, document thiếu file và vector index lệch. Xóa tài liệu cũng đi qua trạng thái/job để không mất khả năng retry.

Định nghĩa tables `outbox_jobs` và `migration_runs` riêng. Không đưa pgvector vào cùng đợt này vì Qdrant đã đảm nhiệm vector; việc đổi vector store cần đánh giá độc lập.

## 8. Lộ trình triển khai

### P0 — Kiểm kê và chuẩn bị migration

- [x] Tạo manifest file hiện có và file service có thể tạo, số lượng, schema, dung lượng, ID, quan hệ và checksum.
- [x] Rà tất cả `loadJson/saveJson` lẫn `readFileSync/writeFileSync` trực tiếp, script maintenance và các trang quản trị.
- [x] Ghi baseline API/chat/memory và test hiện tại; xác định chính sách retention, bản ghi legacy không có account và định dạng thời gian.
- [x] Chốt dependency giữa nhóm dữ liệu, phương án import accounts trước và chế độ đọc auth chuyển tiếp.

Nghiệm thu: mọi file được phân loại; report không chứa secrets; có bản backup kiểm tra checksum.

### P1 — Hạ tầng và repository nền

- [x] Compose, pool, schema migrations, bảng version migration và readiness/shutdown.
- [ ] JSON repository và PostgreSQL repository có cùng contract async cho domain đầu tiên.
- [x] Test thực với PostgreSQL tạm, không dùng database nghiệp vụ/production.

Nghiệm thu: tạo database mới, chạy migration hai lần không lỗi, restart giữ dữ liệu, lỗi kết nối làm readiness thất bại rõ ràng.

### P2 — Chat, memory, audit và feedback

- [x] Import danh tính tài khoản cần tham chiếu trước; trong thời gian auth vẫn dùng JSON, phải đóng băng thay đổi danh tính hoặc định nghĩa bước cập nhật danh tính PostgreSQL bắt buộc trước khi tạo dữ liệu liên quan.
- [x] Chuyển `logger_service` và `memory_service`, thêm chat session ownership, transaction và idempotency.
- [x] Giữ gate `SUCCESS/PARTIAL`, references TTL, pending turn và chặn history thô; không thay đổi tiêu chuẩn chất lượng khi đổi storage.
- [x] Page chat, modal, embed, API thường/SSE và API tương thích đều dùng repository mới qua cùng service.
- [ ] Phân trang lịch sử/feedback; chuyển analytics và training collector sang đọc repository.

Nghiệm thu: lịch sử/feedback đủ, không lưu PARTIAL vào memory thành công, không đọc chéo account/embed, không mất lượt khi hai request ghi đồng thời.

### P3 — Auth và cấu hình quản trị

- [x] Chuyển accounts, auth sessions, API keys, providers, persona, embed configs, data sources và MCP.
- [x] Xử lý credential, public DTO masking và cache invalidation; chọn active provider bằng transaction.
- [x] Giữ đăng nhập, revoke key, session expiry và quyền tool đúng hành vi; không bootstrap tài khoản mới khi dữ liệu cũ chưa được import.
- [x] Loại đường đọc persona trực tiếp từ file; cấu hình kết nối PostgreSQL vẫn ở ngoài database.

Nghiệm thu: CRUD và runtime nhìn cùng cấu hình sau commit; không lộ secrets; các session theo chính sách cutover hoạt động đúng.

### P4 — Dictionary, knowledge, workflow và training

- [x] Chuyển dictionary/columns/relationships/glossary/domain aliases/skills, giữ identity và thứ tự cần thiết.
- [x] Chuyển library/watchfolders và outbox jobs, giữ đường dẫn file và Qdrant IDs.
- [x] Chuyển workflow definitions/runs/steps, system logs, regression cases và resolution status.
- [x] Kiểm tra mọi script export, training, backup và mọi route quản trị không còn vô tình đọc file cũ.

Nghiệm thu: retrieval/schema selection tương đương baseline, tài liệu được tìm và tải đúng, workflow không chạy trùng, báo cáo training giữ liên kết audit/feedback.

### P5 — Cutover và vận hành

- [x] Rehearsal import/verify/rollback trên bản sao dữ liệu.
- [x] Tạm dừng ghi nhóm dữ liệu đang chuyển, gồm API mutations, job nền và CLI liên quan; xử lý hết request đang chạy trước snapshot cuối.
- [x] Backup, import, verify, đổi cấu hình storage rồi chạy smoke test trước khi mở lại ghi.
- [x] Sau mỗi nhóm, xác nhận không còn writer JSON của nhóm đó. Trong giai đoạn chuyển tiếp phải có bảng cấu hình owner rõ ràng cho từng nhóm.
- [x] Khi toàn bộ nhóm đã chuyển, dùng PostgreSQL làm mặc định; JSON chỉ còn import/export/fixtures theo phạm vi rõ ràng.
- [ ] Lập lịch backup, kiểm tra restore, theo dõi lỗi pool/query, latency và dung lượng.

Nghiệm thu: từng nhóm có biên bản đối soát, kiểm thử chức năng và phương án rollback đã chạy thử.

## 9. Quy trình import và rollback

### Import

1. Preflight chế độ chỉ đọc: kiểm tra file JSON hợp lệ, ID trùng, FK thiếu, timestamps, account scope và credential chưa cấu hình.
2. Tạo snapshot có manifest/checksum sau khi dừng writers. Import từ snapshot cố định, không đọc file đang thay đổi.
3. Import theo thứ tự dependency: danh tính/cấu hình cần tham chiếu → sessions/runs/messages/memory → feedback/tool results → dictionary/knowledge/workflow/training theo nhóm đang chuyển.
4. Ghi `migration_runs`, source filename, legacy key và checksum; thao tác idempotent theo khóa ổn định.
5. Không upsert đè bản ghi PostgreSQL mới hơn bằng snapshot cũ. Sau cutover, importer phải từ chối chạy lại vào database active nếu không có chế độ bảo trì rõ ràng.
6. Bản ghi lỗi đưa vào quarantine/report có lý do, không silently skip. Dữ liệu không rõ owner không cấp quyền truy cập cho người dùng thường.
7. Đối soát số lượng, tập ID, FK, tổng lượt theo trạng thái, messages theo phiên và payload đã chuẩn hóa; giải thích mọi chênh lệch do làm sạch.

### Rollback

- Trước khi PostgreSQL nhận ghi mới: có thể quay về snapshot JSON đã đóng băng sau khi xác minh cấu hình.
- Sau khi PostgreSQL đã nhận ghi mới: không chỉ đổi biến môi trường về JSON cũ. Dừng ghi, export trạng thái PostgreSQL ra JSON tương thích, kiểm tra ID/quan hệ/checksum rồi mới chuyển writer.
- Nếu export ngược không bảo toàn schema mới, khôi phục bản PostgreSQL đã backup hoặc rollback code theo schema tương thích; không thực hiện down migration phá dữ liệu để ép quay lại.
- Mỗi đợt cần xác định rõ điểm rollback, phiên bản code/schema và tập dữ liệu phát sinh kể từ cutover.

## 10. Backup và retention

- Dùng `pg_dump`/`pg_restore` cho backup logic; ghi phiên bản công cụ, version schema và kiểm tra restore trên database tạm. Dump không bao gồm file upload hoặc mọi cấu hình cấp cluster; đóng gói các thành phần đó vào quy trình backup riêng. [Tài liệu backup PostgreSQL](https://www.postgresql.org/docs/current/backup-dump.html)
- Backup tài liệu/export và metadata theo một mốc nhất quán bằng maintenance window hoặc manifest/version; backup Qdrant hoặc bảo đảm có thể rebuild index từ nguồn.
- Khóa giải mã credential cần quy trình backup riêng để có thể khôi phục nhưng không đặt chung plaintext với database dump.
- Định nghĩa retention riêng cho audit, system logs, tool payload, workflow runs, messages, pending turn và expired auth sessions. Không tự xóa dữ liệu cũ trong lần import đầu.
- RPO/RTO chốt theo môi trường vận hành; nếu cần khôi phục theo thời điểm, bổ sung WAL archiving/PITR ở đợt vận hành, không coi volume Docker là backup.

## 11. Ma trận kiểm thử và tiêu chí hoàn tất

| Nhóm test | Điều kiện phải đạt |
|---|---|
| Repository contract | JSON và PostgreSQL cho cùng kết quả nghiệp vụ trong giai đoạn chuyển tiếp |
| Migration | Chạy lại không trùng; dữ liệu lỗi có report; ID/FK/timestamps/scope đúng |
| Transaction | Lỗi giữa chừng không để một message hoặc memory cập nhật dở |
| Đồng thời | Hai process cùng cập nhật một phiên không lost update, không trùng sequence |
| Auth | Password hash, expiry, revoke và permission giữ đúng; không bootstrap đè |
| Phân quyền | Account A không đọc được B; hai embed không dùng chung memory chỉ vì trùng client session ID |
| Chat | Page/modal/embed/API thường/SSE đều trả đúng trạng thái và qua cùng memory gate |
| Provider/local | Ca SQL thô và các test hồi quy local vẫn đạt sau đổi storage |
| Cache | Sửa provider/dictionary ở process A được process B nhìn thấy theo SLA refresh đã chốt |
| File/Qdrant | Crash ở từng bước ingest có thể retry; không đánh dấu ready khi index/file chưa sẵn sàng |
| Workflow | Worker chết hoặc retry không chạy trùng tác vụ đã hoàn tất |
| Sự cố PostgreSQL | Không ghi lén về JSON, không báo đã lưu; phục hồi kết nối có kiểm soát |
| Backup/rollback | Restore thật trên database tạm, đối soát lại; rollback không mất dữ liệu sau cutover |
| Hiệu năng | Đo p95 truy vấn thường, pool wait và dung lượng trên tập dữ liệu đại diện; không full-load toàn bảng ở mỗi request |

Các lệnh đã triển khai: `db:migrate`, `data:pg:preflight`, `data:pg:import`, `data:pg:verify`, `data:pg:export`, `backup:pg`, `restore:pg`, `test:storage` và `data:pg:cutover`.

Hoàn tất tích hợp khi tất cả nhóm dữ liệu trong manifest đã có owner PostgreSQL, các test liên quan đạt, backup/restore và rollback đã diễn tập, và không còn đường ghi JSON ngoài phạm vi được giữ lại. Việc đo tải/retention tiếp tục là công việc vận hành sau đó.

## 12. Đợt triển khai đầu tiên đề xuất

Thực hiện P0–P2 trước: Docker PostgreSQL, lớp storage async, schema và migration cho chat/memory/audit/feedback. Đây là nhóm liên quan trực tiếp đến luồng AI vừa tối ưu. Chỉ mở rộng sang P3–P4 sau khi đối soát và test nhóm đầu đạt; không chuyển toàn bộ thư mục `data` trong một lần thiếu khả năng rollback.

File này là kế hoạch độc lập với `THIRD_PARTY_PROVIDER_OPTIMIZATION_PLAN_170926.md`. Runtime đã chuyển và dữ liệu đã được lưu; biên bản hoàn tất ghi kết quả kiểm tra và các hạng mục tối ưu/vận hành còn lại.

## 13. Kết quả triển khai

Đã hoàn tất migration dữ liệu và chuyển toàn bộ service/caller qua ranh giới storage bất đồng bộ, không còn writer JSON khi chọn PostgreSQL. Service xử lý view riêng trong từng operation; I/O và commit được await ở `storage.run/flush`.

Checklist contract/cursor, constructor injection, phân trang và lịch backup còn để trống có chủ đích: chưa thay toàn bộ API domain bằng `findById`/cursor riêng, chưa tối ưu snapshot theo domain hoặc benchmark tải lớn. Analytics/training đã đọc PostgreSQL nhưng phần phân trang chưa hoàn tất. Workflow có lease chống chạy đồng thời; chưa cam kết exactly-once tác động bên ngoài sau crash. Đây là các hạng mục tối ưu/vận hành tiếp theo, không phải runtime vẫn ghi JSON. Biên bản hoàn tất ghi backup/restore, kết quả test và giới hạn request replay.
