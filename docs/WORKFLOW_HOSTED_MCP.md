# Kết nối Claude / Codex ngay trong UI, hỗ trợ host

## Thao tác trong ứng dụng

1. Đăng nhập quản trị, mở **Nghiệp vụ → Kết nối AI** trên thanh công cụ.
2. Nhập **Địa chỉ host công khai**, ví dụ `https://knowledgehub.example.com`. Chỉ nhập origin, không thêm đường dẫn.
3. Bật **Cho phép AI kết nối**, bấm **Lưu kết nối** rồi **Kiểm tra URL**.
4. **Sao chép URL**, ví dụ `https://knowledgehub.example.com/mcp/workflows`.
5. Trong client Claude có hỗ trợ custom MCP connector, thêm URL đó; hoặc trong Codex vào **MCP servers → Add server → Streamable HTTP**, nhập URL và chọn xác thực khi được yêu cầu.
6. Trình duyệt mở trang KnowledgeHub. Đăng nhập nếu cần, kiểm tra ứng dụng yêu cầu quyền và bấm **Cho phép kết nối**.

Sau khi kết nối, nhắn AI: “Tạo nghiệp vụ tra cứu hợp đồng theo mã khách hàng, tối đa 50 kết quả. Đọc catalog thực, lưu draft, validate và chạy fixture; để tôi Publish.” Tải lại danh sách nghiệp vụ để xem draft mới.

Ứng dụng cung cấp URL, màn hình cấp quyền và quản lý kết nối; bạn vẫn phải thêm URL một lần trong Claude/Codex. Không tự cài connector vào tài khoản dịch vụ bên ngoài. Tính năng thêm custom connector phụ thuộc client/gói tài khoản của dịch vụ đó. Codex hỗ trợ HTTP và OAuth theo [OpenAI Docs](https://developers.openai.com/codex/mcp).

## Quản lý quyền trong UI

- **Kết nối của bạn** hiển thị các OAuth grant và token do chính tài khoản đang đăng nhập tạo.
- **Làm mới kết nối** cập nhật danh sách sau khi cấp quyền từ client.
- **Thu hồi** chặn cả access token và khả năng refresh của kết nối OAuth đó.
- Tắt **Cho phép AI kết nối** chặn mọi client trên host. Bật lại giữ các token chưa hết hạn/chưa thu hồi.
- Mục **Client dùng Bearer token** cho phép tạo token 1–90 ngày, sao chép một lần rồi sử dụng trong header `Authorization: Bearer <token>` của client hỗ trợ. Không cần lưu tài khoản/mật khẩu KnowledgeHub vào file cấu hình client.

AI được đọc metadata và package, lưu draft, validate và chạy fixture. Không có tool Publish, xóa, thực thi shell hoặc SQL tùy ý. Mọi lần gọi đều kiểm tra lại tài khoản vẫn active và còn vai trò admin; đổi securityVersion/mật khẩu sẽ làm token cũ mất hiệu lực. Mẫu vẫn tuân theo revision, contract và cơ chế Publish của ứng dụng.

Fixture không truy vấn nguồn SQL thật. Báo cáo fixture đạt không chứng minh SQL chạy đúng trên dữ liệu thật; kiểm tra bản nháp và chạy thử nghiệp vụ trước Publish.

## Host và reverse proxy

MCP chạy cùng tiến trình ứng dụng, cùng cổng và backend lưu trữ JSON/PostgreSQL. Không cần chạy script stdio, tiến trình MCP riêng hoặc một cổng mới. Có thể dùng nhiều instance ứng dụng với cùng PostgreSQL vì transport HTTP không giữ session trong bộ nhớ. Khởi động lại/deploy code mới do người vận hành quyết định; bản cập nhật không tự restart ứng dụng.

Host công khai cần HTTPS với chứng chỉ được client tin cậy. Localhost HTTP chỉ phục vụ thử nghiệm/client trên cùng máy. Việc nhập URL không tự tạo domain, chứng chỉ, tunnel hoặc mở firewall.

Reverse proxy phải chuyển tiếp nguyên các đường dẫn sau tới ứng dụng:

| Đường dẫn | Mục đích |
| --- | --- |
| `/mcp/workflows` | MCP Streamable HTTP, JSON response stateless |
| `/mcp/workflows/authorize` | Màn hình đăng nhập và cấp quyền |
| `/mcp/workflows/token` | Đổi authorization code/refresh token |
| `/mcp/workflows/register` | Dynamic client registration |
| `/.well-known/oauth-authorization-server` | OAuth discovery |
| `/.well-known/oauth-authorization-server/mcp/workflows` | Discovery theo resource path |
| `/.well-known/oauth-protected-resource` | Resource discovery |
| `/.well-known/oauth-protected-resource/mcp/workflows` | Resource discovery theo MCP URL |
| `/api/auth/*`, `/api/workflow-plugins/mcp*` | Đăng nhập và quản lý qua UI |

Proxy toàn bộ origin là cách đơn giản. Ví dụ Nginx trong server block HTTPS đã có certificate:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 90s;
}
```

Đặt `TRUST_PROXY=true` chỉ khi ứng dụng đứng sau reverse proxy do bạn quản lý để cookie/Origin nhận đúng HTTPS. URL lưu trong UI phải trùng origin HTTPS bên ngoài. Không đặt một lớp đăng nhập HTML khác trước `/mcp/*` và discovery: MCP có Bearer/OAuth riêng. Giữ nguyên header `Authorization`, body JSON/form và trạng thái HTTP. Bản hiện tại phục vụ tại root origin, chưa hỗ trợ deploy dưới prefix như `/knowledgehub`.

**Kiểm tra URL** xác nhận trình duyệt hiện tại nhận đúng metadata MCP ở URL đã lưu; nó không xác nhận dịch vụ Claude/Codex từ Internet đã truy cập được. Kết nối và cấp quyền thực tế ở client là bước xác nhận tiếp theo.

## Chi tiết xác thực

OAuth dùng authorization code, PKCE S256, kiểm tra redirect URI đã đăng ký, mã một lần 60 giây và màn hình consent 5 phút. Access token sống 1 giờ; refresh token quay vòng, tối đa 30 ngày cho grant. Token thủ công sống theo số ngày chọn. Chỉ hash token/code/refresh token được lưu; raw token chỉ xuất hiện trong response cấp mới. Session đăng nhập trình duyệt dùng cơ chế cookie hiện có.

Client registration công khai chỉ hỗ trợ public client với `token_endpoint_auth_method=none`; scope là `workflows:author`. Có rate limit tại endpoint. Không dùng hoặc yêu cầu client secret. Cấu hình OAuth issuer/resource lấy từ host được admin lưu, không suy ra từ header Host của request bên ngoài.

## Kiểm thử

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/workflow_mcp_host.test.js tests/workflow_mcp.test.js tests/automation_routes.test.js tests/storage_request_stores.test.js
```

Kiểm thử SDK HTTP thực với backend tạm: tạo draft, Bearer token, OAuth PKCE, mã dùng một lần, refresh xoay vòng, thu hồi parent/child, hạ quyền tài khoản và tắt host. Toàn bộ dữ liệu test được cô lập khỏi instance đang chạy. Chưa thay thế kiểm thử deployment HTTPS công khai và đăng nhập bằng tài khoản Claude/Codex thực tế.
