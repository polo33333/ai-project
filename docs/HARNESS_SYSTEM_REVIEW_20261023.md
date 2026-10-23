# Rà soát cơ chế harness — 23/10/2026

## Kết luận

Lỗi có tính hệ thống: các giai đoạn đang giữ nhiều cách hiểu khác nhau về cùng một yêu cầu. SQL chạy được không đồng nghĩa trả lời đúng; ngược lại, dữ liệu đúng cũng có thể bị bộ kiểm tra cuối loại nhầm. Không nên thêm nhánh theo câu hỏi, mã khách hàng hoặc tên provider.

Đã rà luồng: giải quyết ngữ cảnh hội thoại → tìm workflow → chọn lược đồ/bảng gốc → tạo yêu cầu đầu ra → xác minh JOIN/SQL → thực thi → phép tính bổ sung → dựng câu trả lời → đánh giá hoàn tất/ghi log. Tham chiếu đợt kiểm tra 18 câu trước đó và chạy lại 8 nhóm câu trên API thật, chỉ provider mặc định, nguồn IPMS. Đây là đánh giá kiến trúc và hồi quy có chọn lọc, không phải chứng nhận toàn bộ tính đúng của mọi câu hỏi.

## Các lỗi chung đã sửa

| Điểm | Nguyên nhân | Thay đổi |
| --- | --- | --- |
| Bằng chứng SQL | `qualifiedSql` loại kết quả nhưng bộ hoàn tất chỉ báo `MISSING_SQL` | Dùng chung `assessSqlEvidence`: phân biệt thực thi thất bại, thiếu rows, sai nguồn, phạm vi chưa xác minh/sai, vi phạm plan và thiếu tổng hợp. SQL trả 0 dòng vẫn là bằng chứng thực thi. |
| Vòng sửa | Chờ model viết câu trả lời rồi mới biết kết quả SQL không phù hợp | Đánh giá ngay sau SQL; đưa nguyên nhân vào tool result và yêu cầu sửa ngay. Không tự coi dòng đầu hay preview là tổng. |
| Workflow bắt buộc | Model đã tốn nhiều vòng chọn schema/JOIN rồi SQL mới bị chặn vì chưa khám phá workflow | Backend hoàn tất bước khám phá bắt buộc sau schema cho mọi yêu cầu dữ liệu, kế thừa cơ chế đã dùng cho phân tích. Vẫn kiểm tra quyền và workflow phù hợp. |
| Cache schema | Từ lần thứ ba, query mới có thể nhận snapshot của query trước với trạng thái thành công | Chỉ tái dùng khi cùng nguồn và toàn bộ arguments trùng; tái dùng có giới hạn. Query khác được thực thi thật. Giữ đường JOIN mới hơn khi dùng snapshot cũ. |
| Trường từ JOIN | Contract chỉ tìm trong bảng chính, nên chỉ số/giá/tiền ở bảng chi tiết bị đánh dấu không được cung cấp | Trường yêu cầu tường minh được dò trong schema được cấp quyền; chỉ nhận một kết quả rõ ràng. Trường bảng liên quan phải xuất phát từ đúng cột vật lý trong SELECT, kể cả khi đổi alias. Không nhận trường ẩn, nguồn khác hoặc trùng nghĩa. |
| Khám phá bổ sung | Sau hai lần tìm schema, không còn công cụ để giải quyết tiêu chí chưa rõ | Cho phép tối đa bốn lần nếu contract còn tiêu chí chưa giải quyết; mặc định vẫn hai. Vẫn giữ giới hạn tool/model/token/thời gian. |
| Duyệt phép tính | Model duyệt chỉ thấy câu hỏi và biểu thức, không thấy dữ liệu đã truy vấn | Cung cấp SQL đã xác minh, source, tối đa 20 dòng và cờ preview. Nêu rõ phép trừ giữa hai kỳ có thể âm hợp lệ. |
| Thành công giả | Từ chối phép tính làm tắt yêu cầu dữ liệu và xóa contract; câu trả lời có thể thành SUCCESS | Với yêu cầu dữ liệu, không xóa nhiệm vụ/contract. Phép tính chưa được xác minh chặn hoàn tất bằng `CALCULATION_NOT_VERIFIED`; chỉ thực thi calculator thành công mới xóa cờ. |
| Chẩn đoán | Chỉ lưu SQL validation, không lưu lý do kết quả bị loại ở bước cuối | Audit lưu chỉ số tool call, accepted và mã nguyên nhân. Không đưa SQL, rows, prompt hay thông tin đăng nhập vào phần diagnostics này. |

Các thay đổi không chứa điều kiện KA0021, tháng 2024-02, bảng điện hay model cụ thể. Giữ kiểm tra quyền, nguồn, khóa JOIN, cardinality, chống nhân bản tổng và không dùng preview để tính tổng.

## Những vấn đề còn lại cần giải quyết ở mức thiết kế

1. **Một yêu cầu chuẩn xuyên suốt.** Hiện memory resolution, semantic review, schema selection và legacy plan có thể ghi đè operation/root. Cần một cấu trúc có phiên bản chứa fact/metric, đối tượng, bộ lọc, ngày nghiệp vụ, kỳ, phép tính, đầu ra và nhiệm vụ phân tích; các bước sau bổ sung bằng chứng, không âm thầm thay nghĩa yêu cầu. Review thất bại phải là trạng thái chưa xác minh, không trở thành mặc định nghiệp vụ.
2. **Phân biệt kỳ với năm, snapshot với tổng.** Chạy lại vẫn có trường hợp “cuối kỳ 18/20” bị hiểu là năm 2018/2020 hoặc công nợ tổng hợp thay vì snapshot điện. SQL hợp lệ và không có dòng không chứng minh đã chọn đúng fact/thời gian. Cần metadata kiểu thời gian và metric nghiệp vụ, không sửa bằng regex cho từng câu.
3. **Contract cho phép tính và độ phủ.** Contract hiện mạnh hơn ở các trường danh sách/chi tiết; chưa đủ để chứng minh so sánh có A, B, chênh lệch, %, mẫu số hợp lệ, đúng kỳ và không bỏ bộ lọc. Nó còn có thể đòi tên cột thô dù SQL trả đúng SUM/nhóm tháng dưới alias khác. Cần đầu ra có kiểu và nguồn gốc biểu thức cho aggregate/compare/time series; backend tính công thức từ bằng chứng đủ phạm vi, không chỉ duyệt văn bản trả lời. Không chỉ mở lỏng alias: cách đó có thể làm bảng hai tổng bị công nhận là đã tính xong chênh lệch/%.
4. **Nghiệp vụ/metric được duyệt cho phép tính tài chính.** Dùng SQL tham số hóa có khai báo grain, nguồn, cơ sở thuế, ngày nghiệp vụ, snapshot và chính sách NULL. Workflow chỉ được route khi đáp ứng capability/inputs/outputs; draft chưa nên tự publish. Bảy draft điện đã có SQL oracle nhưng chưa đủ chứng minh chạy đúng xuyên suốt qua chat.
5. **Kết luận phân tích cần bằng chứng.** Hai tháng không đủ kết luận bất thường/dự báo. Câu trả lời dự báo trong đợt chạy đã từ chối số dự báo, nhưng vẫn suy đoán nguyên nhân vận hành/sản xuất không có bằng chứng. Kiểm tra một vài từ “tiêu chí/phương pháp” trong văn bản chưa đủ bảo đảm mọi kết luận được chứng minh.
6. **Budget và context.** Metadata lớn, review nhiều lần và nhiều nguồn phân loại tiêu tốn hàng chục nghìn token. Cần đo chi phí theo stage, tái dùng catalog/schema đúng revision/phân quyền và dành ngân sách cho sửa SQL/hoàn tất. Không giải quyết bằng tăng vô hạn số vòng hay giảm kiểm tra an toàn.
7. **Triển khai và đánh giá.** Local/host từng khác harness đang chạy. Cần version/build ID trong health diagnostics và benchmark trước/sau cùng cấu hình. Mỗi nhóm phải có biến thể và hội thoại nối tiếp/retry; không dùng nhãn SUCCESS làm oracle.

## Chạy thật trong lượt rà soát

Đợt đầu sau các sửa evidence/cache/contract, trước bổ sung discovery và calculation:

| Ca | Engine | Đánh giá thực tế |
| --- | --- | --- |
| Q-007 — tiền hóa đơn | PARTIAL | SQL lấy dòng đã chạy nhưng chưa SUM; thiếu discovery sớm làm hết vòng/ngân sách. |
| Q-008 — chi tiết kỳ | SUCCESS | Trả bốn dòng chỉ số, hệ số, lượng, giá, tiền đúng dữ liệu đối chiếu; contract không còn loại nhầm trường ở bảng chi tiết. |
| Q-009 — dư nợ kỳ | PARTIAL | Chọn nhầm fact công nợ tổng hợp; chưa có SQL. |
| C-003 — so sánh lượng hai tháng | SUCCESS | Sai: bác phép trừ đúng và yêu cầu cung cấp lại số liệu đã truy vấn. Đây là thành công giả, dẫn đến sửa calculation. |
| C-005 — so sánh mua/bán | PARTIAL | Hai tổng có số đúng nhưng thiếu chênh lệch; cách dựng bảng cũng chưa phù hợp. |
| C-006 — so sánh dư nợ hai kỳ | PARTIAL | SQL hiểu kỳ thành năm và trả rỗng. Không được coi là thiếu dữ liệu thật của yêu cầu gốc. |
| T-007 — bất thường | PARTIAL | Có hai tháng, nêu biến động và thiếu tiêu chí/lịch sử, không kết luận bất thường. |
| T-008 — dự báo | SUCCESS | Từ chối dự báo định lượng là phù hợp; nhận xét nguyên nhân vận hành còn vượt bằng chứng. |

Tổng tám lượt: 156,534 giây, 437.049 token hệ thống báo. Không dùng số này để suy ra phần trăm tối ưu token vì chưa có benchmark lặp cùng điều kiện. Chi tiết nội bộ ở `output/ipms-electricity-audit-20261023/systemic-review-local.private.json` và `systemic-audits.private.json`.

Đợt cuối kiểm tra lại Q-007/Q-009/C-003 sau bổ sung discovery và calculation được ghi riêng tại `systemic-final-local.private.json`; không ghi đè kết quả trước.

| Ca đợt cuối | Kết quả |
| --- | --- |
| Q-007 | SUCCESS, SUM sau thuế 6.652.704 đúng oracle; 15,239 giây, 17.656 token. Discovery được backend hoàn tất, không tốn vòng sửa vì thiếu workflow. Đây là một lần chạy, không phải độ ổn định đã chứng minh. |
| Q-009 | PARTIAL, vẫn sai fact và trả danh sách công nợ tổng hợp. Chưa đạt, dù có SQL thành công. |
| C-003 | PARTIAL, SQL đã tổng hợp theo tháng nhưng contract đòi tên trường thô, không nhận alias của tháng/SUM; hết context trước câu trả lời. Chưa đạt. |

Vì vậy thay đổi lần này sửa được các điểm chung có kiểm thử, nhưng chưa hoàn thành phần chuẩn hóa nghĩa nghiệp vụ/đầu ra phép tính. Không được kết luận “đã sửa toàn bộ” hay chỉ publish các draft để che các lỗi còn lại.

## Kiểm thử và phạm vi triển khai

163 kiểm thử đạt: evidence/repair, schema cache, contract/alias/NULL/truncation, JOIN/grain/nguồn, workflow discovery, calculator, provider harness, memory resolution, retry và diagnostics. Có kiểm thử evidence trên ba miền dữ liệu giả lập khác nhau; đây không phải thử thật trên ba provider.

Chỉ thay đổi và khởi động lại server local. Không đổi provider mặc định, cấu hình provider, quyền dữ liệu; không publish workflow, không triển khai/restart host. Unit/integration tests đạt không thay thế đối chiếu số liệu thật. Chưa thể công bố toàn bộ harness ổn định hoặc toàn bộ 18 câu đã đạt.
