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

---

## Giai đoạn A — Đóng nốt bảo mật (ưu tiên P0)

Mục tiêu: đưa hệ thống lên mức có thể mở cho nhiều người dùng thật trong mạng nội bộ
mà không lộ secret hoặc cho phép mutation giả mạo.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| A1 | Thêm CSRF token cho toàn bộ route mutation (POST/PUT/DELETE) | `src/backend/routes/router.js` | Request mutation thiếu/sai token bị từ chối 403; có test giả lập request giả mạo từ origin khác |
| A2 | Thêm cờ `Secure` cho cookie khi chạy HTTPS; giữ `HttpOnly; SameSite=Lax` | `src/backend/routes/router.js` (dòng set-cookie) | Cookie có `Secure` khi `NODE_ENV=production` hoặc biến cấu hình HTTPS bật |
| A3 | Thay `Access-Control-Allow-Origin: '*'` ở các route embed bằng allowlist domain cấu hình được | `src/backend/routes/router.js` (các route ~dòng 428, 436, 779) | Không còn wildcard cho route có gửi cookie/credential; embed vẫn hoạt động với domain trong allowlist |
| A4 | RBAC tối thiểu: phân biệt owner/role trên Library, document, export | `src/backend/routes/router.js`, service Library liên quan | Account không phải chủ sở hữu/không phải admin không đọc/sửa được tài liệu của người khác qua API |
| A5 | Rà soát BE-07: bổ sung corpus test SQL guard cho CTE, subquery, batch statement, identifier đặc biệt | `src/backend/intelligent_core/security_guard.js`, `npm run eval:sql` | Corpus test mới chạy qua `npm run eval:sql` không có câu lệnh vượt giới hạn SELECT/TOP |

**Điều kiện ra khỏi Giai đoạn A:** hoàn thành A1–A3 tối thiểu trước khi cho phép truy cập
ngoài máy cá nhân người phát triển; A4–A5 hoàn thành trước khi có từ 2 nhóm người dùng
trở lên với quyền khác nhau.

---

## Giai đoạn B — Ổn định vận hành & đo hiệu năng (ưu tiên P1)

Mục tiêu: có số liệu thật về hiệu năng và độ bền dữ liệu sau khi vừa cutover sang
PostgreSQL, tránh vận hành "mù" trên hạ tầng mới.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| B1 | Chạy benchmark p95 cho các API tab chính dưới tải giả lập (không chỉ đo snapshot đơn lẻ như hiện tại) | `docs/PAGE_LOAD_PERFORMANCE_180926.md`, `npm run benchmark:http` | Có báo cáo p95/p99 theo số lượng session/document giả lập, so sánh với baseline JSON cũ |
| B2 | Thêm phân trang cho audit log và các API đọc snapshot đầy đủ | `src/backend/routes/router.js`, service audit | API audit hỗ trợ `limit/offset` hoặc cursor; không còn load toàn bộ bảng vào RAM |
| B3 | Cấu hình backup tự động định kỳ + kiểm thử PITR (point-in-time recovery) | `scripts/backup_restore.js`, `docs/POSTGRESQL_DATA_INTEGRATION_PLAN_180926.md` | Có lịch backup chạy tự động (cron/service), đã rehearsal khôi phục từ 1 bản backup ngẫu nhiên |
| B4 | Diễn tập kill/restart worker outbox để kiểm tra idempotency thực tế | `src/backend/knowledge_core/` (outbox/lease) | Sau khi kill giữa chừng 1 job ingest, restart không tạo document trùng, không mất document |
| B5 | Bổ sung integration test E2E thật (HTTP → LLM → SQL → audit) thay vì chỉ core/Qdrant giả lập | `tests/` | Có ít nhất 1 bộ test chạy với SQL Server test instance + Qdrant thật (đánh dấu riêng, không chạy trong CI mặc định nếu cần) |

**Điều kiện ra khỏi Giai đoạn B:** có báo cáo benchmark B1 + ít nhất 1 lần diễn tập backup/restore
thành công (B3) trước khi coi PostgreSQL là nguồn dữ liệu chính thức duy nhất cho môi trường
có người dùng thật.

---

## Giai đoạn C — Chất lượng câu trả lời AI (ưu tiên P1, có thể làm song song B)

Mục tiêu: có **số liệu thật** về độ chính xác thay vì ước lượng, vì đây vẫn là khoảng
trống lớn nhất chưa được các đợt cập nhật hạ tầng gần đây động tới.

| # | Việc cần làm | File liên quan | Tiêu chí nghiệm thu |
|---|---|---|---|
| C1 | Mở rộng golden set SQL từ 12 lên tối thiểu 60 case, phủ đều `record_lookup`, `aggregate_report`, JOIN nhiều bảng | `tests/fixtures/local_sql_golden.json`, `npm run eval:local:semantic` | Đủ 60 case, có holdout riêng (không dùng để tự chấm), phân loại kết quả theo 4 nhóm: đúng / từ chối đúng lúc / sai lộ rõ / sai tự tin (xem mục Ghi chú bên dưới) |
| C2 | Điền `tests/fixtures/retrieval_golden.sample.json` bằng document ID thật từ Library, chạy `npm run eval:retrieval` | `tests/fixtures/retrieval_golden.sample.json` | Có báo cáo Recall@K/MRR thật, không còn placeholder |
| C3 | Bật thử `RERANKER_ENABLED=true`, so sánh kết quả với baseline RRF bằng chính bộ eval ở C2 | `.env`, retrieval service | Có bảng so sánh Recall@K/MRR có/không reranker; quyết định bật mặc định dựa trên số liệu, không dựa cảm tính |
| C4 | Đánh giá tỷ lệ match đúng/sai của GraphRAG keyword router (regex tiếng Việt không dấu) trên golden set | `docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md` (phần GraphRAG) | Có số liệu precision/recall của việc phát hiện câu hỏi quan hệ, quyết định mở rộng từ khoá hay đổi cách tiếp cận |
| C5 | Chỉ sau khi C1 đạt gate: thử bật `skill_core`/few-shot mặc định và đo lại trên golden set | `LOCAL_MODEL_SKILL_CORE_ENABLED`, `LOCAL_MODEL_FEW_SHOT_ENABLED` | Accuracy nhóm "sai tự tin" không tăng so với baseline khi bật flag |

**Ghi chú — 4 nhóm kết quả khi chấm case (áp dụng cho C1):**
1. Đúng.
2. Từ chối/hỏi lại đúng lúc (an toàn, không tính là lỗi nghiêm trọng).
3. Sai nhưng lộ rõ (SQL lỗi cú pháp, bảng rỗng, exception).
4. Sai nhưng trình bày tự tin như đúng — **nhóm nguy hiểm nhất, cần theo dõi riêng**,
   mục tiêu là đưa tỷ lệ này về gần 0% trước khi bỏ bước người duyệt SQL.

**Điều kiện ra khỏi Giai đoạn C:** đạt 60 case ở C1 và có báo cáo tỷ lệ 4 nhóm kết quả,
làm căn cứ quyết định ngưỡng tin cậy cho từng loại tác vụ thay vì một con số % chung.

---

## Giai đoạn D — Mở rộng có kiểm soát (ưu tiên P2, làm sau A–C)

| # | Việc cần làm | Điều kiện kích hoạt |
|---|---|---|
| D1 | Redis/BullMQ cho ingestion queue + dead-letter queue | Khi khối lượng ingest thực tế vượt khả năng outbox Node.js hiện tại (đo ở B1/B4) |
| D2 | Tách router theo domain, chuẩn hoá request/result/error (BE-11) | Khi router tiếp tục phình to, gây khó bảo trì hơn lợi ích trì hoãn |
| D3 | Persistent Knowledge Graph, LLM entity/relation extraction (Phase 3) | Sau khi C4 cho thấy GraphRAG router hiện tại không đủ đáp ứng |
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
| B3 | Backup tự động + PITR | ☐ Chưa bắt đầu | | |
| B4 | Diễn tập kill/restart worker | ☐ Chưa bắt đầu | | |
| B5 | Integration test E2E thật | ☐ Chưa bắt đầu | | |
| C1 | Golden set SQL 60 case | ☐ Chưa bắt đầu (12/60) | | |
| C2 | Retrieval golden fixture thật | ☐ Chưa bắt đầu | | |
| C3 | Benchmark BGE Reranker | ☐ Chưa bắt đầu | | |
| C4 | Đánh giá GraphRAG router | ☐ Chưa bắt đầu | | |
| C5 | Bật thử skill_core/few-shot | ☐ Chưa bắt đầu | | |
| D1 | Redis/BullMQ | ☐ Chưa kích hoạt | | |
| D2 | Tách router theo domain | ☐ Chưa kích hoạt | | |
| D3 | Persistent Knowledge Graph | ☐ Chưa kích hoạt | | |
| D4 | RBAC chi tiết + Docker Compose | ☐ Chưa kích hoạt | | |

---

## Tài liệu tham chiếu

- `README.md` — trạng thái triển khai và roadmap chính thức
- `docs/Backend_Review_Development_Plan-080926.md` — chi tiết BE-01–BE-11
- `docs/LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md` — kế hoạch tối ưu local model
- `docs/POSTGRESQL_IMPORT_STATUS_180926.md` — biên bản chuyển dữ liệu PostgreSQL
- `docs/POSTGRESQL_DATA_INTEGRATION_PLAN_180926.md` — kế hoạch tích hợp PostgreSQL
- `docs/PAGE_LOAD_PERFORMANCE_180926.md` — biên bản hiệu năng tải trang
- `docs/THIRD_PARTY_PROVIDER_OPTIMIZATION_PLAN_170926.md` — tối ưu provider bên thứ ba
