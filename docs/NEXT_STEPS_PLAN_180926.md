# Kế hoạch phát triển tiếp theo — KnowledgeHub AI (ai-project)

> Tổng hợp từ buổi rà soát mã nguồn ngày 18/09/2026, đối chiếu với `README.md`,
> `docs/Backend_Review_Development_Plan-080926.md`,
> `docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md` và trạng thái PostgreSQL cutover
> (`docs/POSTGRESQL_IMPORT_STATUS_180926.md`).
>
> Tài liệu này **không thay thế** các kế hoạch chi tiết đã có trong `docs/`, mà là bản
> kế hoạch hành động rút gọn, gộp các việc còn tồn đọng theo đúng thứ tự ưu tiên mà
> README đã công bố: **bảo vệ secret/quyền → ổn định vận hành/đo hiệu năng → chất lượng
> câu trả lời → mở rộng lưu trữ và worker.**

## 0. Trạng thái xuất phát điểm (18/09/2026)

**Rà soát bổ sung 19/09/2026:** bảng dưới là baseline từ mã nguồn, không phải xác nhận
dịch vụ đang chạy hoặc kết quả kiểm thử live. Các tài liệu lịch sử được nhắc ở đầu file
hiện có file không còn trong working tree; dùng code và báo cáo mới khi triển khai,
không lấy tham chiếu cũ làm bằng chứng đã nghiệm thu.

| Hạng mục | Trạng thái |
|---|---|
| PostgreSQL app store | Đã cutover — schema `app`, migration 001–003, không fallback JSON |
| Credential/API key | Mã hoá AES-256-GCM, DTO không lộ key gốc (BE-01 đã xử lý) |
| Auth | scrypt + bootstrap admin qua biến môi trường (BE-02 đã xử lý) |
| Bind host | Mặc định `127.0.0.1` (BE-09 đã xử lý) |
| CSRF / cookie Secure / CORS allowlist | **Chưa xử lý** (BE-03) |
| RBAC theo Library/folder/document | **Chưa có** |
| SQL guard (regex-based) | Chưa có integration test đủ cho CTE/subquery (BE-07) |
| Ingest transaction (metadata/file/vector) | Một phần — có outbox/lease, chưa exactly-once (BE-08) |
| E2E test với SQL/Qdrant/LLM thật | Chưa có (BE-10) |
| Router lớn / nợ kỹ thuật | Chưa tách domain (BE-11) |
| Golden set SQL semantic eval | 12/60 case |
| Retrieval eval (Recall@K/MRR) | Fixture vẫn là placeholder, chưa chạy với dữ liệu thật |
| BGE Reranker | Sẵn sàng tích hợp, `RERANKER_ENABLED=false` mặc định |
| Redis/BullMQ | Chưa triển khai |
| Backup tự động / PITR | Chưa cấu hình |
| Quan hệ SQL/JOIN | Đã có CRUD quan hệ và schema context; thiếu identity xuyên suốt, khám phá FK và planner JOIN đã xác minh |
| Ảnh trong chat | Hiện gửi metadata tên/kích thước; chưa có luồng byte ảnh qua core/adapter |

### Điều phối ba kế hoạch

| Hạng mục | Tài liệu sở hữu thiết kế | Phụ thuộc và thứ tự |
|---|---|---|
| Quyền, SQL guard, vận hành, đánh giá chung | Kế hoạch tổng này | A là gate phát hành; B và chuẩn bị fixture C có thể làm song song |
| C6 — Quan hệ SQL/JOIN | [SQL_RELATIONSHIP_JOIN_PLAN_190926.md](SQL_RELATIONSHIP_JOIN_PLAN_190926.md) | Baseline/metadata trước; planner sau identity và validator; phát hành sau A4/A5, E2E và gate JOIN |
| C7 — Ảnh đính kèm chat | [CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md](CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md) | Contract/model probe có thể làm song song C6; ưu tiên sau bản JOIN dùng được đầu tiên; có gate payload/fallback/persistence riêng |
| C2/C3/C4, D3 — RAG tài liệu | [RAG_UPGRADE_ARCHITECTURE_PLAN_180926.md](RAG_UPGRADE_ARCHITECTURE_PLAN_180926.md) | Qdrant tìm kiếm chính; PostgreSQL giữ metadata/quyền/job; sửa metric/scope và revision/manifest trước; FTS tùy chọn, graph chỉ bật khi có bằng chứng cải thiện |

P0–P4 trong plan JOIN là tên **giai đoạn nội bộ**, không phải mức ưu tiên toàn dự án.
Không cần chờ xong mọi việc B mới phát triển C6/C7; gate phát hành vẫn phải đạt. C6/C7
không phụ thuộc persistent Knowledge Graph D3. Graph quan hệ SQL khác graph tri thức RAG.

---

## Giai đoạn A — Đóng nốt bảo mật (ưu tiên P0)

Mục tiêu: đưa hệ thống lên mức có thể mở cho nhiều người dùng thật trong mạng nội bộ
mà không lộ secret hoặc cho phép mutation giả mạo.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| A1 | Thêm CSRF token cho toàn bộ route mutation (POST/PUT/DELETE) | `src/backend/routes/router.js` | Request mutation thiếu/sai token bị từ chối 403; có test giả lập request giả mạo từ origin khác |
| A2 | Thêm cờ `Secure` cho cookie trong triển khai HTTPS; giữ `HttpOnly; SameSite=Lax` | `src/backend/routes/router.js` (set và clear cookie) | Production yêu cầu HTTPS; cờ dựa cấu hình HTTPS/trusted proxy, không tin header proxy tùy ý; login/logout chạy đúng, local HTTP có cấu hình riêng |
| A3 | Thay `Access-Control-Allow-Origin: '*'` ở các route embed bằng allowlist domain cấu hình được | `src/backend/routes/router.js` (các route ~dòng 428, 436, 779) | Không còn wildcard cho route có gửi cookie/credential; embed vẫn hoạt động với domain trong allowlist |
| A4 | RBAC tối thiểu: phân biệt owner/role trên Library, document, export | `src/backend/routes/router.js`, service Library liên quan | Account không phải chủ sở hữu/không phải admin không đọc/sửa được tài liệu của người khác qua API |
| A5 | Rà soát BE-07: bổ sung corpus test SQL guard cho CTE, subquery, batch statement, identifier đặc biệt | `src/backend/intelligent_core/security_guard.js`, `npm run eval:sql` | Corpus test mới chạy qua `npm run eval:sql` không có câu lệnh vượt giới hạn SELECT/TOP |

A4 bao gồm quyền quản lý nguồn/dictionary/quan hệ và scope thực thi SQL trước khi bật C6;
không mặc định quyền Library đã bao phủ quyền database. A5 đã có corpus cơ bản, cần mở rộng
và sửa lỗi phát hiện: TOP ở subquery không thay thế giới hạn ngoài cùng, TOP vượt trần phải
bị giới hạn, CTE/SELECT INTO/batch phải kiểm tra đúng cấu trúc. Dùng chung validator với C6,
không xây hai bộ luật lệch nhau. TOP giới hạn dòng trả về không giới hạn chi phí JOIN;
vẫn cần timeout/cancel và tài khoản nguồn read-only.

**Điều kiện ra khỏi Giai đoạn A:** hoàn thành A1–A3 tối thiểu trước khi cho phép truy cập
ngoài máy cá nhân người phát triển; A4–A5 hoàn thành trước khi có từ 2 nhóm người dùng
trở lên với quyền khác nhau.

---

## Giai đoạn B — Ổn định vận hành & đo hiệu năng (ưu tiên P1)

Mục tiêu: có số liệu thật về hiệu năng và độ bền dữ liệu sau khi vừa cutover sang
PostgreSQL, tránh vận hành "mù" trên hạ tầng mới.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| B1 | Chạy benchmark p95 cho API tab chính dưới tải giả lập | `scripts/benchmark_http.js`, `npm run benchmark:http` | Có p95/p99 theo tải và baseline PostgreSQL hiện tại; so JSON cũ chỉ nếu còn số liệu cùng điều kiện, không đổi storage chỉ để đo |
| B2 | Thêm phân trang cho audit log và các API đọc snapshot đầy đủ | `src/backend/routes/router.js`, service audit | API audit hỗ trợ `limit/offset` hoặc cursor; không còn load toàn bộ bảng vào RAM |
| B3a | Backup PostgreSQL định kỳ và restore thử vào database riêng | `scripts/postgres/backup.js`, `npm run backup:pg`, `npm run restore:pg` | Có lịch/retention, kiểm tra checksum và restore; xác minh giải mã với key được quản lý riêng, ghi RPO/RTO; inventory thêm file Library/Qdrant và cách khôi phục/reindex |
| B3b | PITR nếu RPO yêu cầu khôi phục giữa hai bản dump | Thiết kế base backup + WAL archive/retention riêng | Thực sự khôi phục đến timestamp đã chọn và kiểm tra dữ liệu trước/sau mốc; `pg_dump` hiện tại không chứng minh PITR |
| B4 | Diễn tập kill/restart worker outbox để kiểm tra idempotency thực tế | `src/backend/knowledge_core/` (outbox/lease) | Sau khi kill giữa chừng 1 job ingest, restart không tạo document trùng, không mất document |
| B5 | Bổ sung integration test E2E thật (HTTP → LLM → SQL → audit) thay vì chỉ core/Qdrant giả lập | `tests/` | Có ít nhất 1 bộ test chạy với SQL Server test instance + Qdrant thật (đánh dấu riêng, không chạy trong CI mặc định nếu cần) |

**Điều kiện ra khỏi Giai đoạn B:** có báo cáo benchmark B1 + ít nhất 1 lần diễn tập backup/restore
thành công (B3a) trước khi vận hành dữ liệu người dùng thật; B3b là gate bổ sung nếu RPO
đã cam kết đòi hỏi PITR. Không coi việc đã cutover là bằng chứng có khả năng khôi phục.

---

## Giai đoạn C — Chất lượng câu trả lời AI (ưu tiên P1, có thể làm song song B)

Mục tiêu: có **số liệu thật** về độ chính xác thay vì ước lượng, vì đây vẫn là khoảng
trống lớn nhất chưa được các đợt cập nhật hạ tầng gần đây động tới.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| C1 | Mở rộng golden set SQL từ 12 lên tối thiểu 60 case, gồm ít nhất 30 case JOIN theo C6, còn lại lookup/filter/aggregate đơn bảng | `tests/fixtures/local_sql_golden.json`, `npm run eval:local:semantic:live` | Validate fixture rồi chạy live; holdout không dùng làm prompt/few-shot/tuning, chỉ đánh giá độc lập; báo 4 nhóm kết quả và coverage theo loại câu hỏi |
| C2 | Sửa metric evaluator và xây fixture retrieval thật có scope/evidence; chạy `npm run eval:retrieval` | `scripts/evaluate_retrieval.js`, `tests/fixtures/retrieval_golden.sample.json`, plan RAG | Metric hiện tại là HitRate@K; bổ sung Recall@K đúng với nhiều document, dedupe MRR và chấm no-answer riêng; có báo cáo live, không còn placeholder |
| C3 | Bật thử `RERANKER_ENABLED=true`, so sánh kết quả với baseline RRF bằng chính bộ eval ở C2 | `.env`, retrieval service | Có bảng so sánh Recall@K/MRR có/không reranker; quyết định bật mặc định dựa trên số liệu, không dựa cảm tính |
| C4 | Đánh giá GraphRAG keyword router trên bộ câu hỏi quan hệ trong tài liệu | `src/backend/knowledge_core/`, luồng retrieval trong `intelligent_core/core.js` | Đo precision/recall routing và chất lượng truy xuất; tách khỏi quan hệ bảng SQL thuộc C6 |
| C5 | Chỉ sau khi C1 đạt gate: thử bật `skill_core`/few-shot mặc định và đo lại trên golden set | `LOCAL_MODEL_SKILL_CORE_ENABLED`, `LOCAL_MODEL_FEW_SHOT_ENABLED` | Tỷ lệ sai tự tin không tăng; tỷ lệ trả lời đúng và coverage không giảm do từ chối quá mức |
| C6 | Quan hệ SQL và JOIN nhiều bảng theo plan chi tiết | `SQL_RELATIONSHIP_JOIN_PLAN_190926.md` | FK/mapping thủ công trước, suy luận ID sau; đúng kết quả, không vượt scope, không nhân đôi aggregate; đạt gate JOIN trước bật mặc định |
| C7 | Đọc ảnh đính kèm chat qua Ollama theo plan chi tiết | `CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md` | Một ảnh/lượt; hai route chat hoạt động; giới hạn payload, fallback đúng capability, không lưu byte ảnh vào history/memory; có đánh giá live |

**Ghi chú — 4 nhóm kết quả khi chấm case (áp dụng cho C1):**
1. Đúng.
2. Từ chối/hỏi lại đúng lúc (an toàn, không tính là lỗi nghiêm trọng).
3. Sai nhưng lộ rõ (SQL lỗi cú pháp, exception hoặc kết quả lệch đáp án có thể kiểm chứng;
   kết quả rỗng có thể đúng, không tự tính là lỗi).
4. Sai nhưng trình bày tự tin như đúng — **nhóm nguy hiểm nhất, cần theo dõi riêng**,
   gate bộ nghiệm thu là không có case sai tự tin; không giả định runtime đã có bước
   người duyệt SQL. Từ chối khi đủ dữ liệu để trả lời cũng là thất bại, không tính nhóm 2.

**Điều kiện ra khỏi Giai đoạn C:** không chỉ đủ 60 case; cần báo cáo live với đáp án độc
lập, regression truy vấn đơn và gate theo từng tính năng. `eval:local:semantic` hiện chỉ
validate fixture, không chứng minh SQL/model chạy đúng. JOIN dùng gate C6; ảnh dùng bộ
đánh giá riêng C7, không tính ảnh vào 60 case SQL. Test thuần lifecycle/metadata của C6
được tính riêng, không dùng để bù số câu hỏi SQL end-to-end.

---

## Giai đoạn D — Mở rộng có kiểm soát (ưu tiên P2, làm sau A–C)

| # | Việc cần làm | Điều kiện kích hoạt |
|---|---|---|
| D1 | Redis/BullMQ cho ingestion queue + dead-letter queue | Khi khối lượng ingest thực tế vượt khả năng outbox Node.js hiện tại (đo ở B1/B4) |
| D2 | Tách router theo domain, chuẩn hoá request/result/error (BE-11) | Khi router tiếp tục phình to, gây khó bảo trì hơn lợi ích trì hoãn |
| D3 | Persistent Knowledge Graph, LLM entity/relation extraction | Khi đánh giá retrieval cho thấy thiếu quan hệ tài liệu và benchmark chứng minh lợi ích; router sai riêng lẻ chưa đủ lý do xây persistent graph |
| D4 | RBAC chi tiết hơn (theo field/row-level nếu cần), Docker Compose triển khai đầy đủ | Sau khi A4 (RBAC tối thiểu) đã ổn định trong thực tế |

---

## Bảng theo dõi tiến độ (điền khi thực hiện)

| Mã | Tên việc | Trạng thái | Người phụ trách | Ngày hoàn thành |
|---|---|---|---|---|
| A1 | CSRF token | ☐ Chưa bắt đầu | | |
| A2 | Cookie Secure | ☐ Chưa bắt đầu | | |
| A3 | CORS allowlist | ☐ Chưa bắt đầu | | |
| A4 | RBAC tối thiểu | ☐ Chưa bắt đầu | | |
| A5 | SQL guard corpus mở rộng | ☐ Chưa bắt đầu | | |
| B1 | Benchmark p95 | ☐ Chưa bắt đầu | | |
| B2 | Phân trang audit | ☐ Chưa bắt đầu | | |
| B3a | Backup PostgreSQL + restore rehearsal | ☐ Chưa nghiệm thu lịch tự động/restore | | |
| B3b | PITR | ☐ Theo RPO đã chốt | | |
| B4 | Diễn tập kill/restart worker | ☐ Chưa bắt đầu | | |
| B5 | Integration test E2E thật | ☐ Chưa bắt đầu | | |
| C1 | Golden set SQL 60 case | ☐ Chưa bắt đầu (12/60) | | |
| C2 | Retrieval golden fixture thật | ☐ Chưa bắt đầu | | |
| C3 | Benchmark BGE Reranker | ☐ Chưa bắt đầu | | |
| C4 | Đánh giá GraphRAG router | ☐ Chưa bắt đầu | | |
| C5 | Bật thử skill_core/few-shot | ☐ Chưa bắt đầu | | |
| C6 | Quan hệ SQL/JOIN | ☐ Có plan, chưa triển khai | | |
| C7 | Ảnh đính kèm chat | ☐ Có plan, chưa triển khai | | |
| D1 | Redis/BullMQ | ☐ Chưa kích hoạt | | |
| D2 | Tách router theo domain | ☐ Chưa kích hoạt | | |
| D3 | Persistent Knowledge Graph | ☐ Chưa kích hoạt | | |
| D4 | RBAC chi tiết + Docker Compose | ☐ Chưa kích hoạt | | |

---

## Tài liệu tham chiếu

- [SQL_RELATIONSHIP_JOIN_PLAN_190926.md](SQL_RELATIONSHIP_JOIN_PLAN_190926.md) — thiết kế C6
- [CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md](CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md) — thiết kế C7
- [RAG_UPGRADE_ARCHITECTURE_PLAN_180926.md](RAG_UPGRADE_ARCHITECTURE_PLAN_180926.md) — thiết kế retrieval C2/C3/C4 và điều kiện thử graph D3
- Các tên tài liệu lịch sử dưới đây giữ để truy vết; nhiều file hiện không còn trong working
  tree ngày 19/09/2026. Tra Git history nếu cần, không xem là dependency bắt buộc triển khai.

- `README.md` — trạng thái triển khai và roadmap chính thức
- `docs/Backend_Review_Development_Plan-080926.md` — chi tiết BE-01–BE-11
- `docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md` — kế hoạch tối ưu local model
- `docs/POSTGRESQL_IMPORT_STATUS_180926.md` — biên bản chuyển dữ liệu PostgreSQL
- `docs/POSTGRESQL_DATA_INTEGRATION_PLAN_180926.md` — kế hoạch tích hợp PostgreSQL
- `docs/PAGE_LOAD_PERFORMANCE_180926.md` — biên bản hiệu năng tải trang
- `docs/THIRD_PARTY_PROVIDER_OPTIMIZATION_PLAN_170926.md` — tối ưu provider bên thứ ba
