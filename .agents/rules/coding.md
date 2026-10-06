---
trigger: always_on
---

# Khi cập nhật UI chat, đồng bộ chat chính, popup chat và embed chat (bao gồm table, form nghiệp vụ và khối công cụ). Ưu tiên dùng component chung để các giao diện không lệch nhau. Kiểm tra mobile và dark mode.
# Riêng embed chat chỉ hiển thị câu trả lời, bảng/biểu đồ và form nghiệp vụ; không hiển thị Thinking, timeline hay khối công cụ/quá trình xử lý theo yêu cầu người dùng.

# Icon trong coding nên dùng Font Awesome
# Font chữ sử dụng Inter (Google Fonts) hỗ trợ UTF-8 tiếng Việt chuẩn hóa, hiện đại và giống mẫu dashboard nhất
# không có giả lập dữ liệu liên quan đến sql đã kết nối
# Không tự restart lại project , để nguồn dùng quyết định có build, restart ứng dụng
