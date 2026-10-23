# Sửa JOIN trường ánh xạ và xuất file riêng theo nhóm — 23/10/2026

## Lỗi được xác nhận

Audit `c7ba7593-19e8-4fdc-bbe6-8efe9936303e`: câu “Tôi muốn xem danh sách cả nam và nữ, chia thành 2 file riêng.” bị chặn SEMANTIC_JOIN_REQUIRED. Compiler chỉ hỗ trợ truy vấn một bảng trong khi hợp đồng đầu ra yêu cầu tên giới tính từ danh mục liên kết. Đồng thời, kế hoạch cuối mất cờ export; phân nhóm dùng tên khóa gốc trong khi SQL trả alias hiển thị; xuất dữ liệu chỉ chọn một SQL cuối.

## Sửa chung

- Giữ yêu cầu xuất tệp độc lập với các lần lập lại kế hoạch. Nhận cả cách nói “chia thành 2 file riêng”, không bắt buộc động từ “xuất”.
- Compiler bổ sung lookup trực tiếp từ JOIN plan đã xác minh, chỉ quan hệ many-to-one/one-to-one, đúng cặp khóa, đúng cột được phép và nhãn đã cấu hình. Giữ bộ lọc gốc và bỏ FK được thay bởi trường hiển thị. Không gán cứng mã nam/nữ, trạng thái hoặc phòng ban; không nới kiểm tra SQL/JOIN ở connector.
- Liên kết trường phân nhóm giữa khóa nguồn, vai trò nghiệp vụ và alias đầu ra; tên cột vật lý chính xác vẫn được ưu tiên để tránh nhầm khi nhiều cột trùng nhãn.
- Xuất file thực hiện từ từng nhóm của dữ liệu đã xác minh, không dùng dữ liệu model tự dựng hoặc một preview. Mỗi nhóm có file XLSX và link tải riêng, vẫn dùng công cụ export/ACL hiện có.
- Kiểm tra đủ nhóm/số file yêu cầu; thiếu, rỗng hoặc chưa xác minh thì PARTIAL, không ghi nhận hoàn tất. Nếu đã có một file thành công thì giữ link và nêu chưa tạo đủ các file.
- Memory giữ danh sách các file đã xuất; audit lưu số nhóm và lỗi đầu ra.

## Kết quả chạy thật

Cùng session, provider mặc định và nguồn mặc định:

1. “ds nv” → SUCCESS, 9 nhân viên.
2. Câu trong ảnh → SUCCESS, hai link XLSX: Nam 7 hàng, Nữ 2 hàng.

Đã tải cả hai qua HTTP có xác thực: HTTP 200. Đọc lại workbook xác nhận cột ID/mã/tên nhân viên/giới tính, mỗi hàng thuộc đúng nhóm, 9 khóa nhân viên không trùng nhau. Dữ liệu thật và workbook chứa thông tin nhân viên chỉ nằm ở các artifact `.private` trong output.

Runner: `output/ipms-electricity-audit-20261023/run-separate-groups-live.js --followup`.

Kiểm chứng: `verify-separate-groups.cjs`; kết quả `separate-groups-verified.json`.

Kiểm thử toàn dự án: **1.080 test; 1.066 đạt; 0 lỗi; 14 bỏ qua**. Test mới `tests/separate_group_exports.test.js` có đọc lại Excel, kiểm tra từng nhóm và từ chối quan hệ không xác minh/ẩn cột/fanout.

## Phạm vi

### Bổ sung: xuất lại trong phiên đã có JOIN

Ảnh lỗi tiếp theo thuộc phiên cũ đã có cột giới tính từ JOIN. Resolver chọn `operation: export`, khiến schema retrieval bỏ qua bước mở lookup dành cho thao tác dữ liệu `list`. Query thiếu JOIN bị kiểm tra bảo toàn phạm vi từ chối đúng quy tắc.

Đã tách ý định đầu ra `export/chart` khỏi thao tác truy vấn: giữ cờ xuất file, đồng thời dùng thao tác dữ liệu trước đó hoặc `list` để tìm schema. Không nới kiểm tra phạm vi hay bỏ JOIN cũ. Regression test dùng dữ liệu tổng quát Records/Types và thao tác export trên kết quả đã JOIN.

Thử lặp lại còn phát hiện một phạm vi truy vấn được phục hồi thành `semanticGroups` có một phần tử; bước export nhầm đó là một nhóm file và bỏ qua phân nhóm cột. Đã cho trường hợp một phạm vi tiếp tục partition theo `resultGroupBy`; nhiều phạm vi độc lập vẫn giữ cách xuất từng nhóm đã xác minh. Kiểm thử bổ sung tái hiện trường hợp một phạm vi nhưng hai nhóm dữ liệu.

Chạy lại đúng phiên đang lỗi trên provider mặc định: SUCCESS, Nam 7 và Nữ 2; tải hai XLSX HTTP 200, kiểm chứng 9 ID không trùng và đúng nhóm. Artifact: `separate-existing-session-verified.json`. Toàn bộ kiểm thử: 1.081 test, 1.067 đạt, 0 lỗi, 14 bỏ qua.

Sau sửa lỗi phạm vi một phần tử, lặp lại hai lượt liên tiếp trong cùng phiên cũ đều SUCCESS; mỗi lượt tạo hai file 7/2, đọc lại workbook xác minh đủ 9 ID và đúng giới tính.

Compiler lookup tự động hiện hỗ trợ quan hệ trực tiếp, không suy đoán đường nhiều tầng hoặc quan hệ có thể nhân bản ghi; các trường hợp đó vẫn cần SQL/JOIN được kiểm chứng. Xuất nhóm chưa xác minh đủ, số nhóm không khớp hoặc nhóm rỗng không được coi là đã tạo đủ file. Bản sửa đang ở local, chưa triển khai host.
