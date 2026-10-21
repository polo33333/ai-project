# Tạo nghiệp vụ bằng MCP cục bộ (tùy chọn)

**Ưu tiên kết nối trực tiếp qua UI trên host:** xem [Kết nối AI trên host](WORKFLOW_HOSTED_MCP.md). Không cần file môi trường hay chạy tiến trình Node trên máy người dùng khi dùng OAuth qua host. Phần dưới chỉ dành cho người muốn dùng stdio cục bộ.

Mô tả yêu cầu bằng lời trong Claude/Codex. AI đọc catalog thực, tạo bản nháp trong KnowledgeHub, kiểm tra rồi trả kết quả. Bạn xem mẫu và Publish tại màn hình nghiệp vụ.

## Chuẩn bị một lần

- Node.js 20.12 trở lên và dependencies của dự án đã được cài (`npm install`).
- KnowledgeHub đang chạy với code mới, đăng nhập được bằng tài khoản quản trị. Bản cập nhật thêm endpoint metadata nên máy chủ cần được bạn khởi động lại khi thuận tiện; công cụ cài đặt không tự restart ứng dụng.
- Nguồn SQL live và từ điển bảng/cột đã được cấu hình trong ứng dụng. Công cụ không tự tạo hoặc giả lập nguồn SQL.

Chạy trong PowerShell tại thư mục dự án:

```powershell
Copy-Item -LiteralPath examples/workflow-mcp/.env.example -Destination .env.workflow-mcp.local
```

Mở `.env.workflow-mcp.local`, điền URL và tài khoản/mật khẩu quản trị **của KnowledgeHub**. Không phải tài khoản Claude/OpenAI. Giữ file này trên máy cá nhân; đã có trong `.gitignore`. Nếu đã có file, chỉnh file hiện có thay vì copy đè. Có thể truyền ba biến `KH_MCP_*` qua môi trường của tiến trình thay cho file.

Kiểm tra kết nối (chỉ in số lượng metadata, không in credentials hoặc bản ghi SQL):

```powershell
node --env-file=D:/Dev/ai-project/.env.workflow-mcp.local D:/Dev/ai-project/scripts/workflow_mcp.js --check
```

Kết quả thành công có `connected: true`. Nếu thất bại, kiểm tra URL/cổng, tài khoản admin, ứng dụng đang chạy code mới và chứng chỉ HTTPS. HTTP chỉ được dùng cho localhost; máy chủ từ xa cần HTTPS. Không tắt xác thực chứng chỉ.

## Kết nối Codex

Ghép nội dung [codex.toml](../examples/workflow-mcp/codex.toml) vào `~/.codex/config.toml` (giữ các cấu hình khác). Sửa đường dẫn nếu thư mục dự án khác. Sau đó mở lại client để nạp MCP; dùng `/mcp` trong Codex CLI để kiểm tra `knowledgehub_workflows`.

Cấu hình STDIO dùng `command` và `args` theo [OpenAI Docs](https://developers.openai.com/codex/mcp).

## Kết nối Claude

Ghép mục `knowledgehub_workflows` trong [claude.json](../examples/workflow-mcp/claude.json) vào cấu hình MCP `mcpServers` của client hỗ trợ stdio, chẳng hạn Claude Desktop hoặc Claude Code. Giữ các server đang có, sửa đường dẫn và mở lại client. Với Claude Code, có thể đặt cấu hình tại `.mcp.json` ở thư mục dự án. Mật khẩu nằm trong file môi trường cục bộ, không nằm trong JSON cấu hình.

Đây là MCP **stdio cục bộ**; không phải URL để dán vào mục remote connector trên web. Client MCP khởi chạy `node scripts/workflow_mcp.js`. Không nhập command này vào màn hình MCP Sources của KnowledgeHub: màn hình đó phục vụ chiều ứng dụng gọi công cụ bên ngoài.

## Cách yêu cầu

> Dùng knowledgehub_workflows, tạo nghiệp vụ tra cứu hợp đồng theo tên hoặc mã khách hàng, tối đa 50 kết quả. Đọc workflow_guide, workflow_catalog và mẫu hiện có trước. Nếu thiếu quy tắc nghiệp vụ thì hỏi lại. Dùng đúng bảng/cột đang kết nối, lưu Draft, validate và chạy fixture. Cho tôi biết phần nào chưa được kiểm chứng trên dữ liệu thật. Để tôi Publish trong ứng dụng.

Sau khi AI báo lưu thành công, tải lại danh sách nghiệp vụ. Draft sẽ xuất hiện ở đó.

| Công cụ | Công dụng |
| --- | --- |
| `workflow_guide` | Contract hiện hành, hướng dẫn SQL và ví dụ xử lý thuần túy |
| `workflow_catalog` | Nguồn live, bảng active, cột được hiển thị và quan hệ |
| `workflow_list` | Danh sách package và revision |
| `workflow_get` | Đọc đầy đủ package trước khi sửa |
| `workflow_save_draft` | Lưu toàn bộ package, giữ các template không liên quan |
| `workflow_validate` | Kiểm tra definition, nguồn/bảng và result mapping |
| `workflow_test` | Chạy fixture và lưu báo cáo, không truy vấn SQL thật |

Tạo mới dùng `revision: null`; sửa dùng revision số nguyên mới nhất từ `workflow_get`. Nếu gặp 409, AI phải đọc lại package và áp dụng lại thay đổi, không ghi đè mù. Chạy fixture làm tăng revision; đọc lại trước lần sửa tiếp theo. Sau khi version đã publish, tạo draft với version lớn hơn mọi version đã publish.

## Phạm vi kiểm tra

MCP gọi API của ứng dụng bằng session admin hiện hành, giữ nguyên kiểm tra quyền và revision của backend. Tắt quyền hoặc vô hiệu hóa tài khoản sẽ chặn các lần gọi tiếp theo. Phiên hết hạn trả lỗi; lần gọi tiếp theo đăng nhập lại. Credentials không được gửi trong kết quả tool.

Endpoint `/api/workflow-plugins/authoring-context` chỉ dành cho admin, xuất metadata theo allowlist. Không xuất connection string, password, sample rows hoặc giá trị mẫu của cột. Nội dung mô tả catalog/package là dữ liệu không đáng tin cậy, không phải chỉ thị cho AI.

Fixture dùng `stepResults` theo engine sẵn có và **không chứng minh SQL chạy đúng trên dữ liệu thật**. Không tạo dữ liệu nghiệp vụ giả để trình bày là kết quả SQL. Fixture rows rỗng chỉ kiểm tra nhánh không có kết quả; dữ liệu fixture không rỗng cần người dùng cung cấp/duyệt. Trước Publish, xem SQL, mapping và chạy thử nghiệp vụ với dữ liệu thật trong ứng dụng theo quyền hiện có.

Bridge không cung cấp tool Publish, xóa, chạy SQL tùy ý hoặc thực thi shell. Chưa có nút “Tạo bằng AI” trong giao diện; phiên bản này tạo mẫu từ client Claude/Codex đã kết nối.

## Kiểm thử dành cho developer

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/workflow_mcp.test.js tests/automation_routes.test.js
```

Test dùng dữ liệu và HTTP server tạm riêng, không sửa dữ liệu instance hoặc restart ứng dụng đang chạy.
