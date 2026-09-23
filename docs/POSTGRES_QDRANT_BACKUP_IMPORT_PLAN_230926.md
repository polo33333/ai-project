# Kế hoạch: Tạo backup và import PostgreSQL + Qdrant

Ngày: 23/09/2026  
Trạng thái: Đề xuất triển khai; chưa thay đổi runtime.

## 1. Mục tiêu và phạm vi

Tạo một gói backup có thể kiểm tra và import để khôi phục **cùng một trạng thái dữ liệu** của PostgreSQL và Qdrant. Luồng này phục vụ chuyển máy, khôi phục sau sự cố và diễn tập định kỳ. PostgreSQL là nguồn dữ liệu nghiệp vụ chính khi `APP_STORAGE_BACKEND=postgres`; Qdrant chứa các chỉ mục vector phục vụ tìm schema và tài liệu.

Phạm vi bản đầu: CLI cho quản trị viên, backup theo yêu cầu, kiểm tra gói, import vào môi trường đích tách biệt, đối soát và hướng dẫn chuyển ứng dụng sang môi trường mới. UI, lịch chạy tự động và lưu trữ cloud là giai đoạn sau.

## 2. Hiện trạng đã kiểm tra

| Thành phần | Hiện trạng | Việc cần bổ sung |
| --- | --- | --- |
| `scripts/postgres/backup.js` | `pg_dump` định dạng custom cho schema `app`, SHA-256; restore vào database mới tên `knowledgehub_restore_*` | Tái sử dụng và mở rộng metadata/kiểm tra; không restore đè database đang chạy |
| `scripts/backup_restore.js` | Sao chép thư mục `data`, kèm dump PostgreSQL khi bật backend này; lệnh `restore` từ chối ghi JSON lên PostgreSQL live | Làm rõ vai trò dữ liệu file còn cần giữ và tích hợp vào gói thống nhất nếu có |
| `scripts/postgres/cli.js` | `data:pg:import` nhập snapshot JSON legacy vào PostgreSQL | Giữ tên và mục đích riêng; lệnh import gói backup mới phải phân biệt rõ |
| `src/backend/services/qdrant_service.js` | Collection schema lấy từ `QDRANT_COLLECTION`; collection tài liệu từ `QDRANT_DOCUMENT_COLLECTION` | Backup và import cả hai collection; ghi cấu hình vector/embedding trong manifest |
| `compose.docker.yml` | Qdrant 1.18.3 có volume `qdrant_storage` và `qdrant_snapshots`; PostgreSQL dùng volume riêng | Dùng snapshot API của Qdrant và xuất snapshot ra gói backup độc lập với volume container |
| `package.json` | Có `backup`, `restore`, `backup:pg`, `restore:pg` | Thêm tên lệnh riêng cho backup/verify/import gói PostgreSQL + Qdrant |

## 3. Quyết định thiết kế

- Gói backup là một thư mục bất biến gồm `manifest.json`, `postgres/app.dump`, các snapshot Qdrant theo tên collection, và các file ứng dụng ngoài database đã được xác nhận là cần để khôi phục. Không coi volume Docker là gói backup có thể chuyển máy.
- Dùng `pg_dump`/`pg_restore` hiện có cho PostgreSQL. Với Qdrant, gọi snapshot API theo từng collection, tải file snapshot về gói và kiểm tra kích thước/hash. Không xuất từng point rồi tự dựng lại collection nếu snapshot API dùng được.
- Một `backupId` liên kết mọi thành phần. Manifest ghi thời điểm bắt đầu/kết thúc, phiên bản định dạng, phiên bản PostgreSQL/Qdrant, tên collection, vector configuration, embedding model/dimension, số point, checksum SHA-256 và trạng thái hoàn tất.
- Backup nhất quán cần chặn ghi vào ứng dụng và mọi job đồng bộ/index trong suốt cửa sổ chụp. Trình tự: bật maintenance/khóa writer → chờ job đang chạy xong → dump PostgreSQL → tạo/tải snapshot Qdrant → kiểm tra file → ghi manifest hoàn chỉnh → mở lại writer. Nếu chưa có cơ chế chặn writer an toàn, CLI phải yêu cầu ứng dụng dừng và kiểm tra điều kiện này trước khi chạy. Gói thất bại được đánh dấu `incomplete`, không cho import.
- Import vào PostgreSQL database mới và Qdrant instance hoặc collection đích tách biệt. Không xóa hay ghi đè database/collection đang phục vụ traffic. Sau đối soát mới đổi cấu hình kết nối hoặc alias theo runbook triển khai.
- Snapshot Qdrant cần tương thích phiên bản server đích. Kiểm tra phiên bản và cấu hình collection trước khi import; khi không tương thích, dừng với lỗi rõ ràng và dùng quy trình tái lập chỉ mục từ dữ liệu nguồn đã khôi phục.
- Dữ liệu backup có thể chứa credential, nội dung tài liệu và dữ liệu người dùng. Chỉ tài khoản quản trị được chạy lệnh; file tạo với quyền hạn chế, không in secret ra log, hỗ trợ mã hóa khi chuyển/lưu ngoài máy và chính sách lưu giữ/xóa có cấu hình.

## 4. Định dạng gói đề xuất

```text
backups/<backupId>/
  manifest.json
  postgres/app.dump
  qdrant/<schema-collection>.snapshot
  qdrant/<document-collection>.snapshot
  files/                     # chỉ khi kiểm kê xác nhận cần thiết
```

`manifest.json` phiên bản 1 gồm: `backupId`, `createdAt`, `completedAt`, `status=complete`, `storageBackend`, `components[]` (`kind`, `sourceName`, `relativePath`, `bytes`, `sha256`, `version`, `metadata`), `consistencyMode`, `appVersion` và `encryptionKeyRequired`. Đường dẫn luôn tương đối, chuẩn hóa; từ chối `..`, đường dẫn tuyệt đối, symlink và file ngoài thư mục gói. Ghi manifest qua file tạm rồi đổi tên sau khi toàn bộ thành phần đạt kiểm tra.

Không ghi mật khẩu, API key, khóa mã hóa hay chuỗi kết nối vào manifest. Khóa giải mã PostgreSQL phải được cấp riêng ở môi trường đích; import thành công về mặt dữ liệu chưa đủ nếu không giải mã được bản ghi cần thiết.

## 5. Luồng CLI

### 5.1. `backup:all`

1. Preflight: xác nhận `APP_STORAGE_BACKEND=postgres`, quyền đọc PostgreSQL và Qdrant, dung lượng trống, danh sách collection thực tế, phiên bản dịch vụ, trạng thái writer/job và nơi lưu gói.
2. Tạo thư mục tạm có ID duy nhất; áp dụng cơ chế nhất quán ở mục 3.
3. Tạo dump PostgreSQL; tạo snapshot của **cả** collection schema và tài liệu. Nếu collection được cấu hình nhưng chưa tồn tại, fail hoặc ghi rõ ngoại lệ đã được cho phép; không âm thầm bỏ qua.
4. Tải snapshot ra khỏi Qdrant, hash từng file, thu thập count/cấu hình collection; sao chép các file ứng dụng cần thiết sau khi đã kiểm kê.
5. Xác minh file tồn tại, không rỗng, checksum khớp; ghi manifest `complete` và chuyển thư mục tạm sang tên cuối. Xuất đường dẫn, ID và tóm tắt thành phần, không xuất dữ liệu nhạy cảm.
6. Luôn mở lại writer trong `finally`; nếu bước nào lỗi, báo lỗi và giữ gói `incomplete` để kiểm tra/xóa thủ công.

### 5.2. `backup:verify <package>`

Chạy offline: xác thực phiên bản manifest, đủ thành phần bắt buộc, đường dẫn hợp lệ, kích thước và SHA-256 của từng file. Chạy online tùy chọn: kiểm tra công cụ restore và khả năng kết nối môi trường đích. Trả mã thoát khác 0 khi có lỗi; không sửa gói.

### 5.3. `backup:import <package> --target <profile>`

1. Bắt buộc chạy `verify`; kiểm tra target là môi trường mới/rỗng, quyền, phiên bản và dung lượng. Có `--dry-run` in kế hoạch tác động, không thay đổi dữ liệu.
2. Tạo database PostgreSQL mới bằng cơ chế `restore:pg`, import dump trong transaction và kiểm tra schema/bảng/dữ liệu trọng yếu.
3. Import từng snapshot Qdrant vào collection hoặc instance đích chưa phục vụ traffic theo API phù hợp với phiên bản Qdrant; không trỏ alias ứng dụng vào collection đang import.
4. Đối chiếu collection config, point count và mẫu truy vấn schema/tài liệu; xác nhận các file ngoài DB và khả năng giải mã bản ghi PostgreSQL bằng khóa môi trường đích.
5. Ghi `import-report.json` gồm ID gói, target, kết quả từng bước, count và lỗi. Chỉ báo `readyForCutover=true` khi mọi bước đạt. Thất bại giữ môi trường đích để điều tra; không tự động chuyển traffic.

Cutover là bước vận hành riêng: dừng writer ở nguồn, đảm bảo không phát sinh thay đổi sau backup hoặc tạo gói cuối, cấu hình ứng dụng sang PostgreSQL/Qdrant đích, kiểm tra smoke test, rồi mở traffic. Giữ nguồn cũ trong thời gian rollback; rollback bằng đổi cấu hình trở lại nguồn cũ, sau khi đã xử lý các ghi phát sinh ở đích.

## 6. Hạng mục triển khai

| ID | Công việc | Kết quả nghiệm thu |
| --- | --- | --- |
| B1 | Kiểm kê dữ liệu trong `data/`, phân loại file đã ở PostgreSQL và file còn phải mang theo; xác định writer/job Qdrant | Danh sách thành phần bắt buộc và cơ chế tạm dừng ghi rõ ràng |
| B2 | Tách logic dump/restore PostgreSQL hiện có thành hàm dùng chung, giữ nguyên hành vi CLI cũ | `backup:pg` và `restore:pg` vẫn hoạt động |
| B3 | Viết Qdrant snapshot adapter: liệt kê, tạo, tải, kiểm tra, import; URL/auth/timeout/retry có cấu hình | Backup được cả hai collection, lỗi mạng không tạo gói `complete` |
| B4 | Viết package orchestrator, manifest và `backup:verify` | Gói có checksum, chống path traversal/symlink, báo lỗi rõ |
| B5 | Viết import vào target mới, báo cáo đối soát và `--dry-run` | Không có đường thực thi ghi đè target live |
| B6 | Bổ sung npm scripts, README/runbook, retention và hướng dẫn quản lý khóa | Quản trị viên thực hiện được backup, verify, diễn tập import/cutover |

## 7. Kiểm thử và tiêu chí hoàn thành

- Unit test manifest/path/checksum: file bị sửa, thiếu snapshot, symlink, path traversal, gói `incomplete` đều bị từ chối.
- Integration test trên PostgreSQL và Qdrant tách biệt: seed dữ liệu ở cả hai collection, tạo gói, import vào target mới, so sánh bảng/record trọng yếu, count và truy vấn vector mẫu.
- Kiểm thử lỗi giữa các bước: hết dung lượng, Qdrant timeout, dump lỗi, import PostgreSQL thành công nhưng Qdrant lỗi; báo cáo đúng và không đổi traffic.
- Diễn tập phục hồi từ gói đã lưu ngoài máy chủ, đo thời gian backup/import và dung lượng; ghi RTO/RPO thực tế để đặt lịch backup/retention. Kiểm tra giải mã credential với khóa được cấp riêng.
- Hoàn thành khi một gói duy nhất có thể verify và phục hồi PostgreSQL + hai collection Qdrant ở môi trường sạch, báo `readyForCutover=true`, và runbook cho phép chuyển/rollback có kiểm soát.

## 8. Điểm cần chốt khi bắt đầu B1

- `data/` còn chứa file nào là nguồn dữ liệu bắt buộc khi PostgreSQL đã bật, đặc biệt tài liệu gốc/attachment, hay chỉ là dữ liệu legacy/cache?
- Qdrant đích dùng instance riêng hay collection mới cùng instance? Cách chọn ảnh hưởng đến tên collection, alias và API import.
- RPO/RTO mong muốn, nơi lưu bản sao ngoài máy chủ, thời gian retention và yêu cầu mã hóa backup để chọn lịch chạy ở giai đoạn sau.
