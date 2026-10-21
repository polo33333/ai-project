# Kiểm tra input token — 15/10/2026

Phạm vi: snapshot 20 chat gần nhất trước khi nghiệm thu bản sửa. Dữ liệu đầy đủ nằm riêng tại `artifacts/agent-acceptance/latest-twenty-tokens.private.json`.

| Nhóm | Số lượt | Input trung bình | Thấp nhất | Cao nhất |
| --- | ---: | ---: | ---: | ---: |
| Toàn bộ | 20 | 34.445 | 5.663 | 57.356 |
| Người dùng | 11 | 32.329 | 5.663 | 57.356 |
| Nghiệm thu của agent trước đó | 9 | 37.031 | 16.281 | 49.504 |

Trung vị toàn bộ: 37.167. Tổng 688.897 input token / 122 lần gọi model, trung bình 6,1 lần gọi/lượt. Số input hiển thị bằng tổng input của các lần gọi; không thấy cộng đúp trong mẫu kiểm tra.

| Bước | Tổng input | Tỷ trọng xấp xỉ |
| --- | ---: | ---: |
| Agent | 620.433 | 90,1% |
| Tổng hợp cuối | 34.647 | 5,0% |
| Phân giải memory | 28.463 | 4,1% |
| Phân giải ánh xạ schema | 2.946 | 0,4% |
| Đánh giá workflow | 2.408 | 0,3% |

Nguyên nhân chính là các vòng Agent lặp tìm schema, sửa SQL, truy vấn bổ sung và gửi lại lịch sử tool cùng định nghĩa tool. Lượt không có lịch sử người dùng vẫn dùng 28–49 nghìn input, nên không thể quy hết cho số tin hội thoại. Trong lượt có lịch sử, phần memory cũng tăng theo dữ liệu tham chiếu nhưng nhỏ hơn nhiều so với vòng Agent.

Bản sửa dừng đọc dữ liệu khi contract đã đủ và không có đầu ra bổ sung còn chờ; giữ xử lý tiếp nếu còn thiếu tiêu chí, dữ liệu phân trang, biểu đồ, export hoặc grounding tài liệu. Tổng hợp có scope được xác minh chỉ dừng sớm trong điều kiện hẹp. Schema cũ cùng nguồn và bảng gốc được thu gọn khi có bản mới thay thế; giữ nguyên cặp tool_call/tool_result, schema khác phạm vi và audit gốc. Bổ sung số đo ước tính riêng cho message, định nghĩa tool và kết quả tool trong diagnostics.

Nghiệm thu HTTP thực trên 5500, cùng câu hỏi thống kê phí và model:
- Có 16 tin lịch sử: 33.786 input, 7 lần gọi, SUCCESS; tham chiếu trước sửa là 41.546 input / 9 lần gọi, giảm khoảng 18,7%.
- Không có lịch sử: 28.928 input / 6 lần gọi, chưa cải thiện rõ so với mẫu trước đó 28.407 / 6.
- Cả hai vẫn lọc HoUID=21, trả 6 bản ghi, tổng FinalAmount=441529638.

Đây là đối chiếu các lượt thực theo thời gian, không phải benchmark A/B kiểm soát cùng kết quả model và cache. Chưa kết luận mọi nghiệp vụ đã giảm token. Bằng chứng riêng: `token-efficiency-replay.private.json`, `token-efficiency-audits.private.json`. Các vòng tìm schema/sửa SQL trước khi đạt kết quả vẫn còn cần tối ưu.
