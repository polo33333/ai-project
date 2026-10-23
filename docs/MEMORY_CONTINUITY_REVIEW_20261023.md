# Kiểm tra hai lượt chat mới nhất và cơ chế tiếp nối ngữ cảnh

Đã thực hiện sửa và nghiệm thu chuỗi ba lượt trên provider mặc định. Xem [bản sửa và kết quả kiểm chứng](MEMORY_CONTINUITY_FIX_20261023.md). Phần dưới giữ nguyên bằng chứng lỗi trước khi sửa.

## Kết luận

Memory có chạy, nhưng luồng tiếp nối danh sách đang sai. Không phải do frontend gửi sang phiên khác: cả hai audit cùng session. Lượt sau mất điều kiện lọc, chuyển gốc kế hoạch từ hợp đồng sang khách hàng và trả thêm hợp đồng ngoài danh sách trước, rồi vẫn được công nhận SUCCESS.

Phạm vi kiểm tra: dữ liệu audit/memory đang kết nối từ workspace, mã nguồn và phép tái hiện cô lập. Không đăng nhập kiểm tra riêng host trong lượt này. Không sửa mã sản phẩm trong lượt rà soát này.

## Bằng chứng hai lượt

| Giờ ngày 23/10/2026 | Câu hỏi | Kết quả và trạng thái nội bộ |
| --- | --- | --- |
| 06:47:55 | hiện tại có hđ nào hết hạn hay sắp đến hạn (trong 30 ngày) ko, nhớ tách 2 nhóm riêng | Trả 3 hợp đồng hết hạn, nhóm sắp đến hạn rỗng. Hai SQL được chấp nhận, nhưng evaluation lỗi RESULT_GROUPING_UNRESOLVED, status PARTIAL, memoryPersisted=false. Audit e023e7f5-4692-4abd-a752-055102ec0b48. |
| 06:49:12 | hiển thị thêm tên khách hàn cho ds trên | Resolver lỗi UNKNOWN_ID rồi MISSING_REFERENCE. memory mode=none, structured_resolution_unavailable. Truy vấn T_Contract LEFT JOIN M_Customer không có WHERE, trả 4 hợp đồng gồm ID 246 ngoài danh sách trước. Đánh dấu SUCCESS, memoryPersisted=true. Audit b475741b-bf17-430f-a957-59bd75f3d555. |

Danh sách trước: ContractID 11, 57, 105. Yêu cầu “thêm tên” phải giữ các hợp đồng/phạm vi cũ, các nhóm và ngày kết thúc; không tự mở rộng sang hợp đồng 246.

## Chuỗi nguyên nhân

1. **Hai cơ chế phân nhóm chồng lên nhau.** semanticGroups thực thi hai truy vấn và render hai nhóm. Nhưng guarded_agent_harness vẫn kiểm tra resultGroupBy bằng partition trên một SQL cuối. SQL cuối là nhóm rỗng, không có cột đại diện cho nhãn nhóm điều kiện. Vì vậy giao diện nhìn đúng nhưng đánh giá nội bộ PARTIAL. Cần phân biệt nhóm theo truy vấn điều kiện và nhóm theo giá trị cột.
2. **PARTIAL không được ghi vào bộ nhớ thành công.** Đây là chủ đích an toàn hợp lý; lỗi là đánh giá sai và không có bản ghi lượt đã hiển thị với bằng chứng từng phần tách biệt. Không nên sửa bằng cách cho mọi PARTIAL thành công.
3. **Pending turn che toàn bộ tham chiếu cũ.** memory_service đặt referenceCutoff theo thời điểm pending. Dataset trước pending bị loại để tránh gán nhầm kết quả cũ cho câu mới. Bảo vệ này đúng về mục đích nhưng không có dataset/task mới thay thế cho trường hợp đã có dữ liệu xác minh từng nhóm. Resolver vì vậy không có đối tượng phù hợp để chọn.
4. **Resolver thất bại nhưng không chặn mất phạm vi.** Nhánh lỗi bỏ tham chiếu và chỉ dặn model hỏi lại nếu cần. Không có cổng backend buộc dừng khi câu phụ thuộc “ds trên” chưa được giải quyết. Lượt này model tự chọn truy vấn không lọc và completion chỉ kiểm tra các trường đầu ra, không kiểm tra tập hợp đồng của lượt trước.
5. **Kết quả sai được ghi đè memory.** lastPlan thành M_Customer dù kết quả là các hợp đồng; lastDataset ghi 4 hàng và các khóa CustomerName lặp lại. Điều này có thể làm sai các lượt tiếp theo.

## Khoảng trống kiến trúc bổ sung đã tái hiện

- reference_store.deriveReferences chỉ lấy SQL thành công cuối cùng. Với hai nhóm có 3 hàng và 0 hàng, lastDataset.rowCount=0, entityKeys=[]; chưa biểu diễn được một câu trả lời gồm nhiều dataset.
- business_state.fromPlan lưu semanticQuery đơn, không lưu semanticGroups và toàn bộ cấu trúc nhóm. Vì vậy dù xử lý xong lỗi PARTIAL, vẫn có nguy cơ mất nhóm khi nối tiếp.
- Dataset candidate đưa cho resolver chỉ có bảng, số hàng và cột, không có hợp đồng phạm vi đủ để bổ sung trường mà giữ nguyên tập kết quả.
- Bộ nhận diện collection của đường fallback chưa nhận viết tắt “ds trên”. Đây là yếu tố phụ; sửa từ khóa riêng không khắc phục các lỗi kiến trúc ở trên.
- Có kiểm thử cũ chủ động yêu cầu pending che dataset cũ. Muốn sửa phải bổ sung trạng thái tham chiếu đúng, không đơn giản xóa cutoff và để tái sử dụng nhầm dữ liệu.

## Quy trình đúng cần áp dụng

1. **Lưu lượt hội thoại độc lập với xác nhận dữ liệu:** ghi câu hỏi/đáp đã hiển thị và trạng thái SUCCESS/PARTIAL/FAILED; không biến nội dung model thành dữ liệu đã xác minh.
2. **Một answer-result reference có phiên bản:** trỏ tới nguồn, gốc dữ liệu, nhóm kết quả, truy vấn/bộ lọc chuẩn hóa, khóa định danh, độ đầy đủ và bằng chứng. Nhóm rỗng vẫn là một nhóm đã truy vấn; không thay thế toàn bộ câu trả lời bằng nhóm cuối.
3. **Phân giải lượt sau thành thao tác trên yêu cầu trước:** thêm cột, đổi lọc, đổi kỳ, sắp xếp, phân tích hoặc câu độc lập. “Thêm tên” chỉ thay phép chiếu/JOIN bổ sung, giữ các nhóm và điều kiện cũ. LEFT JOIN nếu cần để không làm mất hàng gốc.
4. **Cổng bắt buộc trước SQL:** tham chiếu không giải quyết được thì hỏi lại; không được âm thầm chạy một câu độc lập. Đổi chủ đề thực sự vẫn chạy bình thường. Không tự đoán ID tham chiếu do model trả sai.
5. **Kiểm chứng cả phạm vi và đầu ra:** với bổ sung thông tin cho danh sách đã hiển thị, xác minh danh tính/mức hạt và tập khóa được giữ; với yêu cầu cập nhật dữ liệu hiện tại, chạy lại cùng phạm vi nghiệp vụ và nêu thay đổi nếu có. Kiểm tra quyền/nguồn lại trước mỗi truy vấn.
6. **Chỉ cập nhật active request sau kiểm chứng:** lỗi resolver hoặc sai phạm vi không được ghi đè ngữ cảnh đã xác minh. Bằng chứng từng phần có thể có reference riêng với giới hạn rõ ràng.

## Thứ tự sửa và nghiệm thu

Ưu tiên: bỏ đánh giá phân nhóm trùng; biểu diễn multi-dataset reference; cổng chống chạy độc lập khi thiếu tham chiếu; bảo toàn phạm vi khi thêm cột; chặn ghi đè memory từ kết quả sai phạm vi. Các mục này cần sửa cùng luồng, không thêm nhánh riêng cho hợp đồng.

Bộ nghiệm thu tối thiểu: danh sách hai nhóm → thêm tên khách hàng → thêm mã khách hàng → đổi cách sắp xếp; nhóm có dữ liệu + nhóm rỗng; câu trước PARTIAL; resolver trả ID sai; đổi nguồn; đổi chủ đề; mất quyền; chat mới và hỏi lại. So sánh khóa/phạm vi với truy vấn đối chứng, không chỉ kiểm tra văn bản có tên khách hàng.

Kiểm tra hiện tại: 63 test memory/resolution/workflow đạt. Phép tái hiện cô lập xác nhận pending che tham chiếu, nhóm cuối rỗng làm mất dataset và business state thiếu nhóm: `output/ipms-electricity-audit-20261023/memory-continuity-probes.cjs`. Test xanh hiện chưa phủ chuỗi lỗi thực tế này.

Tiến trình local cổng 5500 bắt đầu 06:45:13, sau thời gian sửa guarded_agent_harness.js (06:42:51) và memory_service.js (06:20:36). Chưa có bằng chứng lỗi này do hai file đó chưa được nạp lại. Hai lượt audit diễn ra sau khi tiến trình khởi động.
