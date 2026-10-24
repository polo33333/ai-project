# Kế hoạch: xử lý tệp ảnh và tài liệu đính kèm trong trò chuyện — 24/10/2026

## 0. Trạng thái bản thử — 24/10/2026

Đã triển khai bản thử cho U1 (hỏi đáp về tệp) và U4 (đọc ảnh). Các phần U2, U3, U5 chưa làm.

**Đã làm**

| Phần | Vị trí |
|---|---|
| Kiểm tra định dạng bằng nội dung tệp: PDF, PNG/JPG/WEBP, DOCX/XLSX (đọc danh mục zip, giới hạn 100 MB khi giải nén, chặn macro và liên kết ngoài), văn bản UTF-8/UTF-16; ảnh tối đa 40 megapixel | `services/attachment_processing.js` → `inspect()`, gọi trong `chat_attachment_service.validate()` |
| Thu hẹp loại tệp: PDF, DOCX, XLSX, CSV, TXT, MD, PNG, JPG, WEBP (cả backend và giao diện) | `chat_attachment_service.js`, `frontend/embed/chat-attachments.js` |
| Đọc tài liệu bằng bộ đọc của Thư viện; lưu bản trích `<fileId>.extract.json` và dùng lại theo sha256 | `attachment_processing.extract()` |
| Đọc ảnh bằng mô hình cục bộ có khả năng `vision` (tự nhận biết qua `/api/show` của Ollama). PDF quét chỉ đọc được bằng Gemini khi được phép | `attachment_processing.transcribe()`, `adapters/ollama.js`, `adapters/gemini.js` |
| Trả lời: nội dung tệp nằm trong thẻ `<tep_dinh_kem>` như dữ liệu, không có công cụ, tệp dài chọn đoạn liên quan câu hỏi, có trích tên tệp/trang | `attachment_processing.answer()` |
| Chọn mô hình xử lý tệp: quản trị viên đánh dấu “Xử lý tệp đính kèm” cho một hoặc nhiều provider trong Quản lý AI Provider (trường `useForAttachments`). Có mô hình được đánh dấu thì chỉ dùng các mô hình đó, theo priority; mô hình người dùng chọn trong ô trò chuyện được ưu tiên nếu nằm trong danh sách. Đánh dấu một mô hình đám mây là đồng ý gửi nội dung tệp tới mô hình đó. Chưa đánh dấu mô hình nào thì tự chọn: chỉ mô hình cục bộ, trừ khi `CHAT_ATTACHMENT_CLOUD_ENABLED=true` | `attachment_processing.candidates()`, `ai_provider_manager.js`, `views/ai_providers.html`, `js/modules/ai_providers.js` |
| Thời hạn lưu (mặc định 7 ngày), dọn mỗi giờ khi có tải tệp; `uploads.jsonl` không còn ghi câu hỏi | `chat_attachment_service.cleanup()` |
| Tệp trong cuộc trò chuyện: nút “Tệp” ở góc phải khung chat (và mục “Tệp đã tải lên” trong menu +) mở cột tệp bên phải (cùng kiểu cột lịch sử hội thoại, có tìm kiếm không phân biệt dấu và nhóm Hôm nay / Hôm qua / Trước đó), liệt kê tệp đã tải lên trong phiên; tệp trùng nội dung (cùng sha256) chỉ hiện một lần, kèm số lần đã tải; chọn “Hỏi tiếp” để đưa tệp vào câu hỏi mới mà không tải lại. API `GET /api/chat/attachments?sessionId=` và `fileRefs` trong `POST /api/chat/attachments` (chỉ chủ tệp dùng được, tối đa 5 tệp, gộp được với tệp mới). Thử lại câu hỏi cũng gửi tệp theo tham chiếu | `chat_attachment_service.list()/resolveRefs()`, `views/page_chat.html`, `js/modules/page_chat.js`, `embed/chat-attachments.js` |
| Tự giữ tệp của câu trước trong ô soạn tin cho câu hỏi tiếp (cùng cuộc trò chuyện, bỏ bằng × hoặc “bỏ tất cả”); tải lên trùng nội dung dùng lại bản trích của cùng chủ tệp (thử thật: 12,9 giây → 0,8 giây) | `page_chat.js` → `carryPageChatAttachments()`, `chat_attachment_service.reuseExtracts()` |
| Sửa lỗi thẻ tệp hiển thị thô sau khi tải lại trang: CSS của thẻ được chèn vào phần tử chưa gắn vào trang | `embed/chat-attachments.js` → `installStyles()` |
| Hủy xử lý khi người dùng đóng yêu cầu; giới hạn thời gian 240 giây; mô hình lỗi thì vẫn giữ tệp và báo người dùng thử lại | `routes/router.js` |
| Biến cấu hình `CHAT_ATTACHMENT_*` | `.env.example`, `services/settings_help.js` |

**Kết quả kiểm chứng**

- `npm test`: 1183 ca, 1169 đạt, 14 bỏ qua, 0 lỗi (tính cả 13 ca mới trong `tests/chat_attachment_processing.test.js`).
- Lần thử đầu trên giao diện thật bị lỗi vì hai nguyên nhân, đều đã sửa: (1) đường `POST /api/chat/attachments` không được nạp danh mục mô hình từ PostgreSQL (`storage/request_stores.js`); (2) bộ chọn mô hình chỉ lấy mô hình mặc định (`isActive`), trong khi mô hình mặc định là Gemini, nên bỏ qua `qwen3.5:9b`. Nay lấy mọi mô hình đang bật, giống ô chọn mô hình trên giao diện. Lỗi xử lý được ghi ra log máy chủ với tiền tố `[Attachments]`.
- Thử thật với `qwen3.5:9b` cục bộ:
  - Ảnh hóa đơn tiếng Việt tự tạo: trả lời đúng số hóa đơn, mã hợp đồng, tổng tiền và sản lượng điện trong khoảng 5 giây. Bản chép đọc sai một chữ có dấu ("Thử" thành "Thí").
  - XLSX + TXT: khoảng 4 giây, trả lời đúng, không làm theo câu chỉ thị cài trong tệp.
- Câu lệnh chép ảnh ban đầu bỏ sót các dòng phía trên bảng. Đã sửa bằng yêu cầu chép đủ theo thứ tự từ trên xuống.
- Chưa thử trên giao diện thật (cần đăng nhập). Chưa thử Gemini thật, vì nhà cung cấp Gemini đang tắt và chưa bật cho phép đám mây.

**Vấn đề có sẵn, phát hiện khi kiểm thử:** `pdf-parse` (pdf.js 1.10) báo `bad XRef entry` với một số PDF dùng bảng xref cổ điển khi `xlsx` hoặc `csv-parse` đã được nạp trong cùng tiến trình. Ca `real multipage PDF…` trong `document_quality_upgrade.test.js` cũng lỗi khi chạy riêng (chỉ qua khi chạy cả tệp). Một PDF thật trong Thư viện vẫn đọc được. Lỗi này ảnh hưởng cả Thư viện, cần xử lý riêng, có thể bằng cách nâng cấp hoặc thay `pdf-parse`.

**Việc còn lại theo thứ tự:** GĐ 3 đưa tệp vào `governance/context` (thay cờ môi trường bằng chính sách nguồn) và quyền `attachments.use`; trạng thái từng tệp trên giao diện; U3 tra cứu hàng loạt; U2 đối chiếu chứng từ; đánh giá chất lượng với ≥ 20 ảnh thật; xử lý lỗi `pdf-parse` và nâng cấp `xlsx`.

## 1. Mục tiêu

Khi người dùng đính kèm ảnh hoặc tài liệu, AI phải đọc được nội dung và dùng nội dung đó đúng mục đích nghiệp vụ, đồng thời tuân thủ đầy đủ quyền truy cập, chính sách gửi dữ liệu tới mô hình và chế độ chỉ đọc với IPMS.

Tài liệu này thay thế và mở rộng phạm vi của `CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md` (vốn chỉ bàn về ảnh). Phần chọn mô hình đọc ảnh và chuyển ảnh qua bộ chuyển đổi mô hình (adapter) vẫn theo tài liệu đó.

Ngoài phạm vi:
- Không ghi vào SQL Server IPMS.
- Không tự động đưa tệp trò chuyện vào Thư viện tài liệu hay cơ sở dữ liệu tìm kiếm.
- Không nhận dạng chữ viết tay ở giai đoạn đầu.

## 2. Hiện trạng

| Phần | Trạng thái | Vị trí |
|---|---|---|
| Nhận và lưu tệp | Đã có: tối đa 5 tệp, mỗi tệp 10 MB, tổng 20 MB; lưu `uploads/chat/<batch>/` kèm `owner` và sha256; chỉ chủ tệp đọc lại được | `services/chat_attachment_service.js`, `routes/router.js` (`/api/chat/attachments`, `/api/chat/attachments/file`, đường nhúng `/api/embed/chat`) |
| Giao diện đính kèm | Đã có (trang trò chuyện và widget nhúng) | `frontend/embed/chat-attachments.js` |
| Đọc nội dung | **Chưa có.** Luôn trả lời "Tính năng xử lý tệp đang phát triển." (`fileProcessingStatus: 'in_development'`) | `chat_attachment_service.response()` |
| Bộ đọc tài liệu | Đã có và đang dùng cho Thư viện: PDF có lớp chữ, DOCX, XLSX, CSV, TXT/MD/SQL. PDF quét báo "cần OCR" | `knowledge_core/services/structured_document.js` (dùng `pdf-parse`, `mammoth`, `xlsx`, `csv-parse`) |
| Đọc ảnh bằng mô hình | Chưa có mã; `ollama.js` chỉ gửi văn bản. Ollama cục bộ đã có `qwen3.5:9b` hỗ trợ `vision` | `intelligent_core/adapters/ollama.js` |
| Quyền với tệp | Chỉ kiểm tra chủ sở hữu; tệp chưa là tài nguyên trong `governance/context` nên chưa có kiểm soát gửi tới mô hình | `governance/context.js` |
| Thời hạn lưu | Chưa có; tệp và `uploads.jsonl` tồn tại vô thời hạn | — |

Kiểm tra định dạng hiện chỉ dựa vào đuôi tệp. Danh sách nhận cả `.gif`, `.heic`, `.tif`, `.doc`, `.ppt`, tức những loại chưa có cách đọc.

## 3. Mục đích sử dụng (theo thứ tự giá trị)

| # | Tình huống | Đầu vào | Đầu ra |
|---|---|---|---|
| U1 | **Hỏi đáp về chính tệp:** tóm tắt, trích điều khoản, so sánh hai bản | PDF, DOCX, TXT, ảnh | Câu trả lời, có trích dẫn trang hoặc đoạn |
| U2 | **Đối chiếu chứng từ với IPMS:** rút mã hợp đồng, số hóa đơn, kỳ, số tiền rồi tra trong hệ thống, báo chỗ khớp và chỗ lệch | Ảnh hoặc PDF chứng từ | Bảng đối chiếu từng trường: giá trị trên tệp, giá trị trong hệ thống, trạng thái |
| U3 | **Tra cứu hàng loạt:** chạy mẫu nghiệp vụ tra cứu cho từng dòng của danh sách mã | XLSX, CSV | Tệp kết quả tải về |
| U4 | **Đọc ảnh chụp màn hình** lỗi, bảng số liệu hoặc biểu đồ để giải thích hoặc nhập lại thành bảng | PNG, JPG | Giải thích hoặc bảng |
| U5 | **Lưu vào Thư viện** để tra cứu lâu dài | Tài liệu | Chuyển sang luồng nạp Thư viện hiện có, cần người dùng chọn và có duyệt |

U2 và U3 là khác biệt chính so với một công cụ hỏi đáp tài liệu thông thường, vì chúng nối tệp với dữ liệu IPMS qua các công cụ và mẫu nghiệp vụ đã có.

## 4. Thiết kế

### 4.1 Luồng tổng thể

```
Tải lên → kiểm tra loại tệp → rút nội dung (chạy nền) → bản trích có cấu trúc
        → AI dùng bản trích như dữ liệu → (U2/U3) gọi công cụ tra IPMS qua kiểm tra quyền
        → hết hạn thì xóa
```

### 4.2 Kiểm tra loại tệp

- Xác định loại tệp bằng **các byte đầu tệp** (chữ ký định dạng), không tin đuôi tệp hay `file.type`. Đuôi tệp và nội dung phải khớp nhau.
- Giai đoạn đầu chỉ nhận: `pdf`, `docx`, `txt`, `md`, `csv`, `xlsx`, `png`, `jpg/jpeg`, `webp`. Bỏ `gif`, `bmp`, `tif`, `heic`, `avif`, `doc`, `ppt`, `pptx`, `odt`, `rtf` cho tới khi có cách đọc. Thông báo rõ cho người dùng là loại nào chưa hỗ trợ.
- XLSX/DOCX là tệp nén: giới hạn tổng dung lượng sau giải nén và số mục bên trong, để chống tệp nén "bom". Không chạy macro, không đọc liên kết ngoài.
- PDF: giới hạn số trang (ví dụ 50 trang). Từ chối PDF có mật khẩu và báo rõ lý do.
- Ảnh: giới hạn số điểm ảnh (ví dụ 16 megapixel) khi giải mã. Nén hoặc thu nhỏ trước khi gửi cho mô hình, nhưng không thu nhỏ ảnh đã đạt giới hạn, để không mất chữ.

### 4.3 Rút nội dung

Tài liệu **dùng lại bộ đọc sẵn có của Thư viện**, `knowledge_core/services/structured_document.js` (`extract(buffer, type)`). Bộ đọc này đã xử lý PDF có lớp chữ, DOCX (giữ bảng và mục), XLSX, CSV, TXT/MD, và trả về các phần có `section`/`rows`. Không viết bộ đọc mới. Chỉ thêm một lớp mỏng `services/attachment_extraction.js` để gọi bộ đọc đó, chuyển kết quả sang `extract.json` và chạy nền theo hàng đợi có giới hạn số tác vụ đồng thời, timeout và hủy được. Cái thực sự phải làm mới là phần đọc ảnh và PDF quét.

| Loại | Cách đọc | Kết quả |
|---|---|---|
| PDF có lớp chữ | `pdf-parse`, giữ số trang | Văn bản theo trang |
| PDF quét (ít hoặc không có chữ) | Tách từng trang thành ảnh, chuyển cho bộ đọc ảnh | Như ảnh, kèm số trang |
| DOCX | `mammoth`, giữ tiêu đề và bảng | Văn bản và bảng |
| TXT/MD | Đọc trực tiếp, chuẩn hóa mã hóa ký tự (UTF-8, NFC) | Văn bản |
| XLSX/CSV | `xlsx`, đọc từng sheet, nhận diện dòng tiêu đề | **Bảng** (tên cột và các dòng), không đổi thành văn bản thường |
| Ảnh | Mô hình đọc ảnh chạy cục bộ qua Ollama (theo `CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md`). Ollama trên máy đang có `qwen3.5:9b` với khả năng `vision` (kiểm tra ngày 24/10/2026), dùng làm ứng viên đầu tiên | Văn bản, bảng, mô tả |

Không dùng công cụ nhận dạng chữ bên ngoài. Mặc định đọc ảnh bằng mô hình cục bộ. Gemini là lựa chọn thêm, được bật theo chính sách (xem 4.3a).

### 4.3a Lựa chọn Gemini cho ảnh và PDF quét

- Hiện trạng: `data/ai_providers.json` đã khai báo Gemini (`gemini-3.5-flash-lite`, `gemini-2.5-flash-lite`) nhưng đang tắt. `adapters/gemini.js` chỉ gửi phần `text`.
- Việc cần làm ở adapter: thêm phần `inlineData: { mimeType, data }` (base64) cho tin nhắn của người dùng. Gemini đọc trực tiếp được ảnh và **cả tệp PDF** (gồm PDF quét), nên không cần tách trang thành ảnh. Tệp lớn hơn giới hạn gửi trực tiếp thì dùng File API của Gemini. Kiểm tra giới hạn hiện hành trong tài liệu chính thức lúc triển khai.
- Gemini là **đích xử lý đám mây**:
  - Chỉ được dùng khi tệp có mức nhạy cảm và `modelDestinations` cho phép, kiểm tra qua `assertEgress`.
  - Không tự chuyển sang Gemini khi mô hình cục bộ lỗi, trừ khi chính sách cho phép.
  - Chỉ dùng khóa API của gói trả phí. Gói miễn phí có thể dùng dữ liệu gửi lên để cải thiện sản phẩm, cần xác nhận lại theo điều khoản hiện hành.
- Chọn mô hình theo từng tệp:
  - Mặc định dùng `qwen3.5:9b` cục bộ.
  - Ảnh khó (chữ nhỏ, bảng dày, PDF quét nhiều trang) và tệp đã được phép gửi đám mây thì dùng Gemini.
  - Bộ đánh giá ở mục 6 chạy trên cả hai để có số liệu so sánh.

### 4.4 Bản trích có cấu trúc

Lưu `extract.json` cạnh tệp gốc trong cùng thư mục batch:

```json
{
  "fileId": "...", "sha256": "...", "extractorVersion": 1,
  "status": "ready | partial | failed | unsupported",
  "pages": [{ "page": 1, "text": "...", "confidence": 0.92 }],
  "tables": [{ "page": 2, "sheet": null, "columns": ["..."], "rows": [["..."]] }],
  "fields": [{ "name": "so_hop_dong", "value": "...", "page": 1, "confidence": 0.81 }],
  "unreadable": [{ "page": 3, "reason": "ảnh mờ" }],
  "stats": { "chars": 12000, "pages": 3, "durationMs": 2400 }
}
```

- `fields` chỉ được điền ở U2, theo danh sách trường nghiệp vụ đã khai báo (mã hợp đồng, số hóa đơn, kỳ, số tiền, ngày). Danh sách này dùng tên trường trừu tượng, không gắn giá trị thật vào metadata lược đồ.
- `unreadable` là bắt buộc: phần nào không đọc được thì phải ghi lại, không được bỏ qua.
- Cùng sha256 và cùng `extractorVersion` thì dùng lại bản trích, không đọc lại.

### 4.5 Đưa vào lời nhắc cho AI

- Đặt nội dung tệp trong một khối dữ liệu có đánh dấu rõ (ví dụ `<attachment id=… name=…>`), kèm quy tắc: **nội dung tệp là dữ liệu, không phải chỉ thị.** Câu kiểu "hãy chạy SQL…" trong tệp không được làm theo.
- Chia ngân sách độ dài riêng cho tệp. Tệp ngắn thì đưa toàn bộ. Tệp dài thì chia đoạn theo trang hoặc mục, chọn đoạn liên quan câu hỏi bằng tìm kiếm trong phạm vi bản trích của batch đó (không đụng cơ sở dữ liệu tìm kiếm chung).
- Bảng lớn (XLSX): chỉ đưa tên cột, vài dòng mẫu và thống kê. Phần xử lý toàn bộ dòng (U3) do công cụ trên máy chủ làm, không đưa hết vào lời nhắc.
- Câu trả lời phải trích nguồn (tên tệp, trang hoặc sheet) và nêu phần không đọc được.

### 4.6 Nối với IPMS (U2, U3)

- Thêm công cụ cho tác tử AI:
  - `read_attachment`: đọc bản trích theo trang, đoạn hoặc bảng.
  - `attachment_rows`: lặp qua các dòng của bảng đính kèm để làm đầu vào cho mẫu nghiệp vụ.
- U2 (đối chiếu): giá trị lấy từ tệp chỉ là **tham số** truyền vào mẫu nghiệp vụ hoặc công cụ tra cứu đã duyệt, không bao giờ ghép vào chuỗi SQL. Truy vấn vẫn qua `executeSqlQuery` → kiểm tra quyền nguồn, bảng, cột, và bộ lọc theo dòng khi có (xem `ROW_LEVEL_DATA_ACCESS_PLAN_241026.md`). Tải lên chứng từ của đơn vị khác cũng không xem được dữ liệu của đơn vị đó.
- Kết quả đối chiếu hiển thị theo từng trường với 3 trạng thái: khớp, lệch, không tìm thấy, kèm độ tin cậy khi đọc. Trường đọc có độ tin cậy thấp thì đánh dấu "cần kiểm tra lại", không kết luận lệch.
- U3 (hàng loạt): giới hạn số dòng mỗi lần (ví dụ 500), chạy qua cơ chế chạy mẫu nghiệp vụ hiện có (`automation/runtime.js`) với giới hạn tốc độ, có tiến độ và hủy được. Kết quả xuất thành tệp qua `governance/artifacts`.

### 4.7 Quyền và chính sách gửi dữ liệu

- Coi tệp đính kèm là **tài nguyên được quản trị** trong `governance/context`, loại `attachment`:
  - Chỉ chủ tệp đọc được. Widget nhúng thì gắn với phiên của widget.
  - Mức nhạy cảm mặc định `internal`.
  - Đích xử lý: mặc định **chỉ mô hình cục bộ**. Gửi tới mô hình đám mây phải được admin bật theo chính sách, và đi qua `assertEgress` như nguồn SQL và tài liệu.
- Quyền chức năng mới: `attachments.use`, thêm vào danh mục trong `account_roles.js`. Đường `/api/chat/attachments` hiện chỉ cần `chat.use`. Tách riêng để admin có thể tắt riêng tính năng đính kèm.
- Ghi nhật ký: ai tải lên, loại tệp, sha256, bộ đọc, đích xử lý. Không ghi nội dung tệp.

### 4.8 Lưu trữ và xóa

- Tệp và bản trích trong trò chuyện có thời hạn, ví dụ `CHAT_ATTACHMENT_RETENTION_DAYS=7`. Có tác vụ dọn định kỳ, và xóa luôn khi người dùng xóa phiên trò chuyện.
- `uploads.jsonl` chỉ ghi metadata, không ghi câu hỏi đầy đủ. Đưa nó vào chính sách thời hạn hoặc chuyển sang PostgreSQL của ứng dụng.
- Lịch sử trò chuyện chỉ lưu metadata tệp (tên, loại, kích thước, batchId) và câu trả lời. Không lưu base64 hay nội dung trích ra, kể cả khi người dùng tự gửi vào API lưu phiên.
- Không dùng nội dung tệp cho bộ nhớ dài hạn hay dữ liệu huấn luyện. Bộ nhớ chỉ được ghi "người dùng đã đối chiếu hợp đồng X", không ghi nội dung.
- Sao lưu: loại `uploads/chat` khỏi bản sao lưu mặc định, hoặc tôn trọng thời hạn.

### 4.9 Lưu vào Thư viện (U5)

- Thêm nút "Lưu vào thư viện" trên tệp đã đọc xong. Bấm nút sẽ tạo yêu cầu nạp qua `library_service` hiện có, theo quyền `library.*` và chính sách nguồn tài liệu. Admin duyệt nếu chính sách yêu cầu.
- Sau khi vào Thư viện, tệp theo thời hạn và quyền của Thư viện, không còn thuộc thời hạn của tệp trò chuyện.

### 4.10 Giao diện

- Mỗi tệp hiển thị trạng thái: đang đọc, sẵn sàng, đọc được một phần, không đọc được, chưa hỗ trợ. Người dùng có thể đặt câu hỏi trong lúc tệp đang đọc; câu trả lời sẽ chờ tệp đọc xong.
- Có nút xem nhanh phần nội dung đã đọc được, để người dùng tự kiểm tra trước khi tin kết quả đối chiếu.
- Nếu mô hình đang chọn không đọc được ảnh, báo rõ ngay khi người dùng đính kèm ảnh, không âm thầm bỏ ảnh đi.

## 5. Các giai đoạn

| GĐ | Nội dung | Kết quả kiểm tra được |
|---|---|---|
| 0 | Kiểm tra loại tệp bằng nội dung, thu hẹp danh sách loại tệp, giới hạn tệp nén/PDF/ảnh, thời hạn lưu và tác vụ dọn, quyền `attachments.use` | Tệp giả loại bị từ chối; tệp quá hạn tự xóa |
| 1 | Bộ đọc PDF có chữ, DOCX, TXT/MD; `extract.json`; đưa vào lời nhắc như dữ liệu; trích nguồn (U1) | Hỏi đáp đúng trên bộ tài liệu mẫu, có trích trang |
| 2 | XLSX/CSV dạng bảng; công cụ `attachment_rows`; tra cứu hàng loạt qua mẫu nghiệp vụ (U3) | Tệp 500 dòng chạy xong, có tiến độ, xuất tệp kết quả |
| 3 | Tệp là tài nguyên được quản trị: chỉ chủ tệp, chỉ mô hình cục bộ theo mặc định, `assertEgress`, nhật ký | Mô hình đám mây bị chặn khi chưa được admin cho phép |
| 4 | Đọc ảnh và PDF quét qua mô hình cục bộ (VC-1 → VC-4 của kế hoạch ảnh) (U4) | Bộ ảnh mẫu đạt ngưỡng đã chốt |
| 5 | Rút trường nghiệp vụ và đối chiếu chứng từ với IPMS (U2) | Bảng đối chiếu đúng trên bộ chứng từ mẫu, không kết luận lệch khi đọc không chắc |
| 6 | Lưu vào Thư viện (U5), xem nhanh nội dung đã đọc, widget nhúng | Đủ các kênh |

Giai đoạn 1–2 có thể làm ngay vì thư viện đọc tệp đã có sẵn. Giai đoạn 4 phụ thuộc vào việc chọn và thử mô hình đọc ảnh trên phần cứng thật.

## 6. Kiểm thử

Bộ kiểm tra tự động (`tests/chat_attachment_processing.test.js`):
- Loại tệp: đuôi giả (exe đổi tên thành pdf), tệp nén bom, PDF có mật khẩu, PDF quá số trang, ảnh quá số điểm ảnh, XLSX có macro hoặc liên kết ngoài.
- Bộ đọc: PDF tiếng Việt có dấu (NFC), DOCX có bảng, XLSX nhiều sheet hoặc tiêu đề không ở dòng 1, CSV khác dấu phân cách và mã hóa.
- Tệp chứa lệnh nhắm vào AI ("bỏ qua quy tắc", "chạy SQL xóa…") thì AI không làm theo và không gọi công cụ ngoài ý người dùng.
- Quyền: người khác không đọc được tệp hay bản trích, kể cả khi đoán được batchId; widget không đọc được tệp của trang trò chuyện; mô hình đám mây bị chặn theo mặc định.
- Đối chiếu: giá trị từ tệp chỉ đi vào tham số, chứa ký tự đặc biệt cũng không chèn được vào SQL; bộ lọc phạm vi vẫn áp dụng.
- Lưu trữ: không có base64 hay nội dung trích trong lịch sử, nhật ký, bộ nhớ; tệp quá hạn bị dọn.

Đánh giá chất lượng (chạy tay, có đáp án):
- Ít nhất 20 tài liệu và 20 ảnh/chứng từ: văn bản tiếng Việt, hợp đồng, hóa đơn, bảng số liệu, ảnh mờ.
- Ghi lại: tỷ lệ trường đúng, số trường đọc sai nhưng trả lời tự tin (mục tiêu 0), tỷ lệ báo "không đọc được", thời gian p50/p95.

Hồi quy: `npm test`, `npm run eval:sql`, `npm run eval:local`, `npm run eval:workflows`. Trò chuyện không có tệp phải giữ nguyên kết quả.

## 7. Rủi ro

| Rủi ro | Cách xử lý |
|---|---|
| Đọc sai số liệu trên ảnh hoặc chứng từ, dẫn tới kết luận đối chiếu sai | Độ tin cậy cho từng trường; dưới ngưỡng thì "cần kiểm tra lại"; có nút xem nhanh nội dung đã đọc |
| Tệp chứa chỉ thị độc hại nhắm vào AI | Khối dữ liệu tách biệt, quy tắc "dữ liệu không phải chỉ thị", công cụ vẫn qua kiểm tra quyền |
| Lộ dữ liệu nhạy cảm lên mô hình đám mây | Mặc định chỉ mô hình cục bộ, `assertEgress` |
| Tải nặng máy chủ (PDF lớn, ảnh lớn, tệp hàng loạt) | Hàng đợi có giới hạn đồng thời, timeout, giới hạn trang/dòng/điểm ảnh |
| Đầy ổ đĩa vì tệp không bao giờ bị xóa | Thời hạn lưu và tác vụ dọn ở GĐ 0 |
| Thư viện đọc tệp có lỗ hổng (`xlsx` 0.18.x có cảnh báo bảo mật đã biết) | Kiểm tra phiên bản và thay bằng bản được vá hoặc thư viện khác trước GĐ 2; chạy bộ đọc với giới hạn tài nguyên |

## 8. Việc cần chốt trước khi làm

1. Ưu tiên tình huống nào trước: U1 (hỏi đáp tệp), U2 (đối chiếu chứng từ) hay U3 (tra cứu hàng loạt).
2. Danh sách trường nghiệp vụ cần rút cho U2 và mẫu nghiệp vụ tra cứu tương ứng trong IPMS.
3. Thời hạn lưu tệp trò chuyện (đề xuất 7 ngày).
4. Có cho phép gửi tệp tới mô hình đám mây không, và với mức nhạy cảm nào.
5. Mô hình đọc ảnh cục bộ cụ thể và cấu hình máy chạy nó.
