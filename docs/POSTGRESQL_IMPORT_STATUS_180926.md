# Hoàn tất chuyển dữ liệu sang PostgreSQL — 18/09/2026

## Bổ sung: lịch sử giao diện page chat

Đã áp dụng migration `003_page_chat_history.sql`. Page chat tải/lưu phiên, tiêu đề, ghim, message hiển thị và history qua `/api/page-chat/sessions`, bảng `app.ui_chat_sessions`. Dữ liệu được mã hóa, tách theo account và kiểm tra version khi sửa/xóa để tránh ghi đè từ thiết bị khác. localStorage không còn ghi danh sách phiên/nội dung mới; chỉ giữ ID đang mở và tùy chọn giao diện.

Lịch sử cũ trong trình duyệt chỉ nhập sau khi người đang đăng nhập xác nhận đó là dữ liệu của mình; chỉ xóa bản cũ sau khi lưu thành công. PARTIAL có thể nằm trong message hiển thị nhưng không được thêm vào history SUCCESS hoặc memory thành công. Khi tải/lưu lỗi, ứng dụng thông báo và chặn gửi tiếp; lỗi kết nối có nút thử lưu lại, xung đột version yêu cầu tải lại trang.

Kiểm tra bổ sung: `npm test` đạt 200 test, hai nhóm integration chạy riêng; `test:storage` đạt 30 test. Readiness hiện yêu cầu schema 3. `backup:pg`/`backup` bao gồm bảng mới; export JSON legacy hiện chỉ xuất các store legacy, không xuất lịch sử giao diện này. Muốn phục hồi đầy đủ cần database dump.

Ứng dụng đã đọc/ghi dữ liệu bằng PostgreSQL. Database `knowledgehub_app`, schema `app` ở trạng thái `live`; `.env` và `.env.postgres` đã chọn `APP_STORAGE_BACKEND=postgres`. Backend dùng role `knowledgehub_runtime`, PostgreSQL 18.6 chạy trong Docker.

## Dữ liệu đã giữ và chuyển

Đã nhập và đối soát toàn bộ 22 file JSON, giữ ID, thứ tự, Unicode, password hash, token, timestamp và metadata. Snapshot cuối: `backups/postgres-import-2026-09-17T18-56-14-995Z-a6a5b468/`. Checksum toàn bộ dữ liệu nguồn trong `data/` vẫn khớp snapshot; JSON gốc được giữ làm bản sao, không còn là nơi ghi khi chọn PostgreSQL.

| Nhóm tại cutover | Số lượng |
|---|---:|
| Account / auth session | 1 / 1 |
| API key / nguồn SQL Server / provider | 2 / 2 / 5 |
| Persona / embed config | 1 / 1 |
| Dictionary table / column | 94 / 1.610 |
| Glossary / domain / alias | 6 / 6 / 27 |
| Skill | 2 |
| Chat audit / tool call / feedback | 989 / 1.035 / 54 |
| Memory session / message / memory state | 50 / 612 / 50 |
| System log | 500 |
| Workflow / definition step / run | 1 / 2 / 2 |
| Library metadata / watchfolder / scan log | 4 / 1 / 281 |
| Regression case | 4 |

Các store chưa có dữ liệu như MCP và training resolutions cũng hỗ trợ PostgreSQL. Bảy memory session legacy thiếu account được giữ nguyên; không suy đoán owner để cấp quyền truy cập.

Đã chuyển logger, memory, auth, API key, provider, persona, embed config, data source, MCP, dictionary, library, watchfolder, workflow, regression và training resolution. Page chat, modal, embed, API thường, API tương thích và SSE đi qua cùng ranh giới storage. Các script training, sanitize, dictionary migration, retrieval và backup cũng xử lý chế độ PostgreSQL.

File tài liệu, nội dung trích xuất và export vẫn ở filesystem. SQL Server giữ dữ liệu nghiệp vụ; Qdrant giữ vector index.

## Cơ chế runtime

- Bootstrap chờ database/schema/live trước khi mở HTTP; readiness lỗi trả 503. Không tạo account mới để ghi đè dữ liệu cũ.
- Repository thực hiện I/O bất đồng bộ trong `storage.run(...)`. Service xử lý view riêng cho từng operation; commit hợp nhất thay đổi theo record với trạng thái mới nhất, không ghi đè snapshot cũ toàn bộ.
- Transaction ngắn giữ memory, cặp message và audit nguyên tử. HTTP success/cookie và SSE final chỉ gửi sau commit; SSE progress vẫn truyền trong khi xử lý.
- Gate SUCCESS/PARTIAL được giữ; PARTIAL không vào successful memory. Account/embed owner do server xác định.
- Chat đồng thời không mất message; sửa cấu hình cùng field bị xung đột trả 409. Active provider có constraint duy nhất; scan song song giữ thống kê scan mới nhất.
- `X-Request-Id` cùng owner/path/body trả response đã commit, không nhân đôi memory/audit; khác body trả 409. Kiểm tra receipt hiện diễn ra lúc commit, nên retry có thể gọi model/tool trước đó. Không cam kết exactly-once cho tác động bên ngoài.
- Ingest/delete tài liệu có outbox bền vững, retry và lease. Workflow/watchfolder có lease chống chạy đồng thời; lease không thay thế idempotency của HTTP/SQL/tool bên ngoài.
- Khi PostgreSQL lỗi, backend báo lỗi lưu, không tự chuyển sang ghi JSON. Shutdown dừng worker và đóng pool.

## Backup và bảo mật

Backup sau cutover: `backups/postgres-2026-09-18T02-47-39-982Z.dump`, có manifest SHA-256. Đã restore vào database tạm mới và đối soát khớp 22 nhóm, sau đó xóa database tạm. Biên bản: `backups/post-cutover-restore-report-180926.json`.

Credential dùng AES-256-GCM với context record; token/API key có hash lookup. Khóa ở `APP_DATA_ENCRYPTION_KEY_FILE`, ngoài repository. **Phải backup khóa riêng ở nơi an toàn; database dump không đủ để giải mã credential.** Backup có dữ liệu nhạy cảm và được ignore khỏi Git.

`npm run backup` sao lưu filesystem và app.dump khi dùng PostgreSQL; dump có manifest tương thích `restore:pg`. Restore chỉ tạo database mới tên `knowledgehub_restore_*`, không ghi đè database đang chạy. Sau khi PostgreSQL nhận ghi mới, không đổi về JSON cũ: phải export trạng thái hiện tại hoặc restore PostgreSQL đã kiểm chứng.

## Vận hành

Backend đang chạy tại `http://127.0.0.1:3000`. `/health/live` kiểm tra process; `/health/ready` kiểm tra storage. Readiness đã trả 200 với backend postgres và schema 2.

```powershell
# Docker Desktop cần đang chạy
docker start knowledgehub-postgres
npm start

npm run backup
npm run backup:pg
npm run restore:pg -- <file.dump> knowledgehub_restore_kiemtra
npm run data:pg:export -- <thu-muc-moi>
npm run test:storage
```

Không chạy lại import/cutover vào database live. Migration mới dùng `npm run db:migrate`; không sửa migration đã áp dụng.

## Xác minh và giới hạn

- `npm run test:ci`: 198 test ứng dụng đạt, 0 lỗi; hai nhóm PostgreSQL chạy riêng. Local harness 3/3; SQL security 7/7.
- `npm run test:storage`: 29 test đạt với PostgreSQL thật trong database tạm: encryption, rollback, import idempotency, concurrent chat/config/scan, auth, scope embed, HTTP/SSE commit gate, request replay, outbox và quyền runtime.
- Health/live, health/ready, auth/me và login page đã smoke test. Role runtime đã ghi PostgreSQL bằng cách lưu persona cùng nội dung, không đổi nội dung người dùng.
- Chat test dùng core giả lập, ingest dùng Qdrant giả lập; không gọi provider tính phí hoặc truy vấn dữ liệu nghiệp vụ thật để kiểm thử migration.

Việc chuyển nơi lưu dữ liệu đã hoàn tất. Tối ưu tải lớn còn tách riêng: snapshot đọc các domain hiện có mỗi operation, commit dùng advisory lock ngắn; chưa triển khai query theo domain/cursor pagination và benchmark p95 tải lớn. Backup đã có lệnh và restore đã kiểm chứng; lịch backup tự động/PITR và giám sát cần cấu hình theo môi trường triển khai.
