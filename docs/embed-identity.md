# Danh tính người dùng Embed Chat

Trong **Quản lý tài khoản → Server xác thực Embed Chat**, chọn widget và nhập:

- Địa chỉ server website (HTTPS; HTTP chỉ cho localhost khi phát triển).
- Issuer: giá trị `iss` do website cấp.
- Audience: giá trị `aud` dành riêng cho widget.
- Khóa công khai RSA PEM từ 2048 bit. Giữ khóa riêng trên server website.
- Bật xác thực; chọn yêu cầu đăng nhập nếu muốn chặn khách.

KnowledgeHub kiểm tra chữ ký RS256 bằng khóa đã cấu hình, issuer, audience, subject và thời hạn token; không gọi URL server để lấy thông tin. Token tối đa còn hạn một giờ, khuyến nghị cấp token 5 phút. Token sai bị từ chối kể cả khi cho phép khách. Tài khoản bên ngoài không trở thành tài khoản quản trị/nội bộ và không được cấp thêm quyền truy cập dữ liệu.

## Kết nối server website

Mẫu Node.js: `examples/embed-identity-server.js`. Gắn handler vào `/api/chat-identity` của website sau middleware phiên đăng nhập hiện tại:

```js
const { createChatIdentityHandler } = require('./embed-identity-server');
const handler = createChatIdentityHandler({
  privateKey: process.env.CHAT_IDENTITY_PRIVATE_KEY,
  issuer: 'https://website.example',
  widgets: { 'ID-CUA-WIDGET': 'knowledgehub-chat' },
  getAuthenticatedUser: async req => req.user
    ? { id: req.user.id, displayName: req.user.displayName }
    : null
});
// Trong router server website: gọi handler(req, res) tại GET /api/chat-identity.
// req.user phải được middleware xác thực của website thiết lập.
```

Tạo cặp khóa bằng `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` hoặc công cụ quản lý khóa của server. Không đưa khóa riêng vào frontend hoặc repository. Endpoint chỉ dùng phiên đăng nhập thực tế, không nhận ID/tên người dùng từ trình duyệt để ký. Không bật CORS cho endpoint cấp token.

Đặt trước script Embed Chat trên website:

```html
<script>
window.KnowledgeHubIdentity = {
  async getToken(embedId) {
    const response = await fetch('/api/chat-identity?embedId=' + encodeURIComponent(embedId), {
      credentials: 'same-origin', cache: 'no-store'
    });
    if (!response.ok) throw new Error('Không thể xác thực danh tính');
    return (await response.json()).token;
  }
};
</script>
```

Widget lấy token mới cho mỗi yêu cầu, không lưu token danh tính vào browser storage. Khi đổi tài khoản, widget bắt đầu phiên mới và xóa hội thoại đang hiển thị. Server liên kết danh tính với lịch sử chat và ràng buộc token tác vụ với danh tính để ngăn truy cập tác vụ của người khác.

## Theo dõi phiên

Trong Quản lý tài khoản, **Phiên Embed Chat gần đây** hiển thị tên/ID đã xác thực, widget, website và lần hoạt động cuối. Bấm làm mới để cập nhật. Widget gửi heartbeat mỗi 30 giây khi tab hiển thị; sau 90 giây không hoạt động thì hiển thị Offline. Đây là hoạt động gần đây, không phải trạng thái đang gõ. Phiên lưu tạm trong bộ nhớ một tiến trình tối đa 24 giờ, mất sau khi restart; triển khai nhiều tiến trình cần kho presence dùng chung.

Lịch sử chat hiển thị tên/ID trong cột nguồn Embed Chat và lưu `visitorIdentity` trong audit, không lưu token danh tính. Danh tính chỉ áp dụng cho lượt mới, không suy ngược danh tính của lịch sử cũ.
