# Kế hoạch: làm lại Quản trị dữ liệu — 27/10/2026

Trang: `http://localhost:5500/admin/data-governance`

## 1. Mục tiêu

1. Nguồn SQL khi đã chia sẻ thì **mọi AI đang bật đều dùng được**, không phải cấp riêng cho từng provider.
2. Tài liệu (thư viện, RAG, thư mục theo dõi) **mặc định chia sẻ cho mọi AI**. Hạn chế là quyết định của admin, theo từng tài liệu hoặc cả thư mục.
3. Quản lý quyền **theo vai trò**. Mỗi vai trò được ghép từ các **nhóm chức năng**, mỗi nhóm gồm quyền chức năng, nguồn, gói bảng và mẫu nghiệp vụ. Ngoại lệ cho từng người chỉ dùng khi cần.
4. Làm lại giao diện cho khớp: nhìn tổng quan được, chọn từ danh sách thay vì gõ mã, sửa hàng loạt, xem được "ai thấy gì".

Ngoài phạm vi:
- Không ghi gì vào SQL Server IPMS. Chính sách vẫn lưu trong kho dữ liệu của ứng dụng (JSON / PostgreSQL) như hiện nay.
- Lọc theo dòng đã có kế hoạch riêng (`ROW_LEVEL_DATA_ACCESS_PLAN_241026.md`). Kế hoạch này chỉ chừa chỗ (`sql.rowRules`, `scopeAttributes` trên nhóm chức năng) để hai phần ghép được với nhau.

## 2. Hiện trạng và vì sao thấy cứng nhắc

| # | Vấn đề | Nguyên nhân trong mã |
|---|---|---|
| A | Hỏi dữ liệu bằng Gemini bị chặn dù nguồn đã "chia sẻ" | `governance/context.js` `canSend()` / `assertEgress()`: mức `internal` (mặc định) với `modelDestinations` rỗng thì **chỉ cho model cục bộ**. Muốn dùng Gemini phải gõ mã `provider-1785683549410` vào từng nguồn. Hiện có 3 provider Gemini và 2 Ollama, nên mỗi nguồn cần 3 mã. Thêm provider mới thì phải sửa lại toàn bộ nguồn. |
| B | Tài liệu RAG / thư mục theo dõi "biến mất" với model cloud | `knowledge_core/rag/signal.js` `routableDocuments()` lọc qua `canSend()`. Tài liệu từ thư mục theo dõi được tạo không có chính sách, nên rơi vào mặc định chỉ cục bộ. Hiện 4/4 tài liệu và 2/2 nguồn SQL đều chưa có chính sách. |
| C | Hai nơi cùng quản lý quyền đọc, kết quả là phần giao nhau | (1) Chính sách nguồn: `visibility`, `subjects`, `roles`, `embedIds` (trang Quản trị dữ liệu). (2) `dataAccess` của vai trò và tài khoản (trang Tài khoản, `account_roles.effective()`). `canRead()` phải qua **cả hai**, nên admin khó đoán vì sao một người không đọc được. |
| D | Một ô nhập dùng cho nhiều loại đích khác nhau | `modelDestinations` gộp provider, `embedding:*`, `reranker`, `mcp:*`, `api:*`, `web:*`. Bảy lời gọi `refresh(<đích>)` (adapters, qdrant, retrieval, mcp, api_http, web_search) đều kiểm tra cùng một danh sách. |
| E | Phân quyền bảng chỉ có một trần chung cho cả nguồn | `allowedTables` / `blockedColumns` áp cho mọi người như nhau. Chặn theo tên cột trần (chặn `Amount` là chặn ở mọi bảng). Chặn một cột khóa làm mất luôn quan hệ (`join_path.js:40`). Gặp `SELECT *` là bị từ chối (`sql_policy.js:15`). |
| F | Giao diện | Chỉ sửa được từng nguồn một. Phải gõ `account:ID`, mã vai trò, Embed ID, mã provider bằng tay, cách nhau bằng dấu phẩy. Không có bảng tổng quan, không xem được "người X đọc được gì". Chỉ tiêu phải sửa dạng JSON. Khối "Chất lượng vận hành Agent" nằm lẫn trong trang. |

## 3. Mô hình mới

### 3.0 Tổng quan: ai quyết định cái gì

| Câu hỏi | Quyết định ở đâu | Mặc định |
|---|---|---|
| **Người này dùng được gì?** (chức năng, nguồn, gói bảng, mẫu nghiệp vụ) | **Vai trò** = tổng các **nhóm chức năng** của vai trò (mục 3.5) | Vai trò `user` dùng nhóm "Người dùng (chuyển đổi)", bằng đúng quyền hiện nay |
| **Nguồn này mở cho ai?** | Nguồn: `access.mode` (Mọi người / Theo nhóm chức năng / Chỉ admin) | Mọi người |
| **AI nào được nhận dữ liệu của nguồn?** | Nguồn: `aiSharing` (Tất cả AI / Chỉ cục bộ / Tắt AI) | **Tất cả AI** |
| **Nguồn SQL chia thành những gói bảng nào? Cột nào nhạy cảm, bảng nào ẩn?** | Nguồn: `sql.packages`, `sql.hiddenTables` (mục 3.7) | Chuyển đổi: một gói "Toàn bộ" |
| **Ngoại lệ cho một người** | Nguồn: `access.users` (cấp thêm) / `access.denyUsers` (chặn) | Không có |

Nói ngắn: **nguồn mô tả cấu trúc** (mở hay hạn chế, gửi AI nào, chia gói ra sao), còn **nhóm chức năng cấp quyền** (ai dùng gói, nguồn, mẫu nào). Quyền chỉ được **cộng thêm** khi ghép nhóm. Muốn trừ bớt thì dùng ngoại lệ chặn từng người. Vì vậy không còn chuyện phải lấy phần giao nhau giữa hai nơi như hiện nay.

### 3.1 Chính sách nguồn (`governedPolicy` phiên bản 2)

```json
{
  "schemaVersion": 2,
  "revision": 7,
  "access": { "mode": "all", "users": [], "denyUsers": [] },
  "aiSharing": { "level": "all", "excludeDestinations": [] },
  "sql": {
    "allowedTables": [], "rowRules": [],
    "packages": [], "hiddenTables": []
  },
  "inheritFrom": null,
  "updatedBy": "…", "updatedAt": "…"
}
```

- `access.mode`:
  - `all`: mọi tài khoản có quyền chức năng tương ứng (`sql:read` hoặc `knowledge:read`).
  - `grants`: chỉ vai trò có nhóm chức năng chứa nguồn này, hoặc người có trong `access.users`.
  - `admin`: chỉ admin. Dùng cho nguồn đang cấu hình hoặc nhạy cảm.
- `access.users` / `access.denyUsers`: ngoại lệ cấp thêm hoặc chặn đích danh. Chặn có ưu tiên cao nhất.
- Widget nhúng **không còn danh sách `embedIds` riêng**. Widget được gán vai trò (mục 3.6).
- `aiSharing.level`:
  - `all`: mọi provider đang bật, kể cả provider thêm sau này, cùng embedding và reranker của hệ thống.
  - `local`: chỉ model chạy cục bộ (Ollama / localhost).
  - `off`: AI không được dùng nguồn này. SQL không truy vấn được qua trò chuyện; tài liệu không vào RAG.
- `aiSharing.excludeDestinations`: tùy chọn nâng cao, mặc định ẩn, để loại trừ vài provider. Đây là danh sách **loại trừ**, nên thêm provider mới không phải sửa lại nguồn.
- `sql.*`: gói bảng, bảng ẩn, cột nhạy cảm (mục 3.7). `allowedTables` cũ được giữ làm trần chung của nguồn.
- `inheritFrom`: `"watchfolder:<id>"` khi tài liệu dùng chính sách của thư mục (mục 3.4).

### 3.2 Quy tắc đọc (thay `canRead()`)

```
effective(actor):                                  // nhớ theo revision vai trò + nhóm chức năng
  role   = actor.channel == 'embed' ? widget.role : actor.role
  groups = role.functionGroups ∪ account.extraFunctionGroups
  return hợp (union) của mọi nhóm: permissions, sources, packages (lấy mức cao nhất), workflows

canRead(resource, actor):
  policy = normalize(resource)                     // đọc được cả v1 và v2
  if role == 'admin': return true
  eff = effective(actor)
  if eff.permissions ∌ (sql:read | knowledge:read): return false
  if policy.access.denyUsers ∋ actor.subject:      return false
  switch policy.access.mode:
    'all'    → true
    'admin'  → false
    'grants' → eff.sources ∋ resource.id || policy.access.users ∋ actor.subject
```

`dataAccess` của vai trò và tài khoản **bị bỏ** (chuyển đổi theo mục 6). Lý do một người đọc được hay không luôn giải thích được bằng một câu, ví dụ "nhờ nhóm chức năng *Tài chính & công nợ* của vai trò *Kế toán*".

### 3.3 Quy tắc gửi dữ liệu ra ngoài (thay `canSend()` / `assertEgress()`)

Các đích được chia theo **loại** thay vì nằm chung một danh sách:

| Loại đích | Lấy từ | `level = all` | `level = local` | `level = off` |
|---|---|---|---|---|
| `provider` (model trò chuyện) | `ai_provider_manager` | Cho phép, trừ khi provider có cờ `rejectInternalData` hoặc nằm trong `excludeDestinations` | Chỉ provider cục bộ | Chặn |
| `embedding`, `reranker` | `qdrant_service`, `retrieval_service` | Cho phép | Chỉ khi chạy cục bộ | Chặn |
| `mcp`, `api` | `mcp_service`, `automation/api_http` | Cho phép (admin tự cấu hình các đích này), có công tắc chung để tắt | Chặn | Chặn |
| `web` (tìm kiếm web) | `web_search_service` | **Luôn cho phép** | Luôn cho phép | Luôn cho phép |

- Tìm kiếm web là tiện ích mở rộng, mọi người dùng được, **không gắn với chính sách nguồn** (đã chốt 27/10). `refresh('web:…')` bỏ bước kiểm tra gửi dữ liệu, chỉ kiểm tra người dùng còn đăng nhập. Câu tìm kiếm vẫn được ghi nhật ký.
- Thêm hàm `destination(id)` trong `governance/policy.js` để đổi chuỗi hiện có (`provider-…`, `embedding:…`, `mcp:…`, `web:…`) thành `{ kind, id, local, name }`. Vì vậy bảy lời gọi `refresh(...)` **không phải đổi chữ ký**.
- Cờ `rejectInternalData` (mặc định `false`) đặt trên AI Provider. Đây là cách duy nhất để "chặn một provider", và chỉ đặt **một lần trên provider**.
- Admin vẫn bị kiểm tra gửi ra ngoài: admin được bỏ qua quyền đọc, nhưng không được bỏ qua quyền gửi.
- Thông báo lỗi ghi rõ tên, ví dụ: `Nguồn “X” đang đặt “Chỉ AI cục bộ”, nên không gửi được tới Gemini. Đổi tại Quản trị dữ liệu → Nguồn dữ liệu.`

### 3.4 Tài liệu và thư mục theo dõi

- Tài liệu tải lên hoặc lấy từ thư mục: mặc định `access.mode = all`, `aiSharing.level = all`.
- Mỗi thư mục theo dõi có **chính sách mặc định** (`access` + `aiSharing`). Tài liệu mới của thư mục được gắn `inheritFrom = "watchfolder:<id>"` và dùng chính sách của thư mục **tại thời điểm kiểm tra**. Đổi chính sách thư mục thì cả thư mục đổi theo.
- Nếu admin sửa riêng một tài liệu, chính sách được chép xuống tài liệu và `inheritFrom` về `null`. Giao diện hiện nhãn "Đã tùy chỉnh · Khôi phục theo thư mục".
- Muốn hạn chế theo vai trò thì đặt `access.mode = grants`, rồi thêm tài liệu hoặc thư mục vào nhóm chức năng tương ứng.
- `refresh()` cần đọc thêm `watchfolders.json`, và tệp này phải được thêm vào danh sách `files` của `storage.run`.

### 3.5 Vai trò và nhóm chức năng (đã chốt 27/10)

**Vai trò được ghép từ nhiều nhóm chức năng.** Mỗi nhóm chức năng là một gói trọn cho một việc nghiệp vụ.

| Thành phần của nhóm chức năng | Ví dụ |
|---|---|
| Quyền chức năng (13 quyền hiện có) | `chat.use`, `sql:read`, `library.read`, `history.read`… |
| Nguồn SQL và tài liệu (chỉ cần với nguồn đặt `grants`) | IPMS, thư mục "Quy trình kế toán" |
| Gói bảng và mức, theo từng nguồn SQL | IPMS → Tài chính & công nợ: Đầy đủ; Hợp đồng: Tra cứu |
| Mẫu nghiệp vụ (chỉ cần với mẫu đặt "Theo nhóm chức năng") | "Đối soát công nợ" |
| *(sau này)* Phạm vi dòng `scopeAttributes` | `don_vi = [HN]`, theo kế hoạch lọc theo dòng |

**Ví dụ nhóm chức năng:**

| Nhóm chức năng | Gồm |
|---|---|
| Cơ bản | Trò chuyện, tài liệu, lịch sử, bộ nhớ cá nhân, tìm kiếm web |
| Tra cứu hợp đồng | Tra SQL, gói Hợp đồng (Tra cứu) |
| Quản lý hợp đồng | Tra SQL, gói Hợp đồng + Kinh doanh (Đầy đủ), mẫu "Báo cáo hợp đồng" |
| Tài chính & công nợ | Tra SQL, gói Tài chính (Đầy đủ), mẫu "Đối soát công nợ" |
| Vận hành tiện ích | Tra SQL, gói Tiện ích + Phản hồi (Đầy đủ) |
| Nhân sự | Tra SQL, gói Nhân sự + Chấm công (Đầy đủ), Nhân viên (Đầy đủ) |
| Lương & bảo hiểm | Tra SQL, gói Lương & bảo hiểm + Chấm công (Đầy đủ) |
| Báo cáo quản trị | Báo cáo, tổng quan, chỉ tiêu đã duyệt |

**Ghép thành vai trò:**

| Vai trò | Nhóm chức năng |
|---|---|
| Kế toán | Cơ bản + Tài chính & công nợ + Tra cứu hợp đồng |
| Kinh doanh | Cơ bản + Quản lý hợp đồng |
| Vận hành KCN | Cơ bản + Vận hành tiện ích + Tra cứu hợp đồng |
| Nhân sự | Cơ bản + Nhân sự |
| Lương | Cơ bản + Lương & bảo hiểm |
| Quản lý | Cơ bản + Quản lý hợp đồng + Tài chính & công nợ + Vận hành tiện ích + Báo cáo quản trị |
| `khach_widget` | Cơ bản (bỏ lịch sử và bộ nhớ) |

**Quy tắc ghép**
- Quyền của vai trò bằng **tổng** quyền các nhóm chức năng của nó. Nếu hai nhóm cấp cùng một gói ở hai mức khác nhau, lấy mức cao hơn.
- Nhóm chức năng chỉ **cấp thêm**, không chặn. Muốn chặn thì dùng `denyUsers` trên nguồn hoặc bảng ẩn.
- Sửa một nhóm chức năng thì mọi vai trò dùng nó đổi theo. Trước khi lưu, giao diện hiện "Ảnh hưởng tới vai trò: Kế toán, Quản lý (12 tài khoản)".
- Tài khoản có thể thêm **nhóm chức năng bổ sung** (`extraFunctionGroups`) để cấp thêm cho một người mà không phải tạo vai trò mới. Tính năng này thay cho "quyền riêng cho tài khoản" hiện nay.
- Vai trò `admin` giữ nguyên là toàn quyền.

**Lưu trữ**
- Tệp mới `account_function_groups.json`, lưu giống `account_roles.json` và cũng có bản ở PostgreSQL:
  ```json
  { "id": "tai_chinh", "name": "Tài chính & công nợ", "description": "",
    "permissions": ["chat.use", "sql:read"],
    "sources": { "sql": ["<sourceId>"], "documents": [], "watchfolders": [] },
    "packages": { "<sourceId>": { "<packageId>": "full" } },
    "workflows": ["<workflowId>"],
    "revision": 3 }
  ```
- Vai trò: `{ id, name, description, functionGroups: [ids], revision }`. Trường `permissions` và `dataAccess` cũ của vai trò được chuyển sang nhóm chức năng (mục 6).
- `effective(actor)` được nhớ theo (revision vai trò, revision từng nhóm chức năng, nhóm bổ sung của tài khoản). `refresh()` thêm `account_function_groups.json` vào danh sách `files` để đổi quyền giữa chừng vẫn được kiểm tra lại.

**Vì sao chọn cách này**
- Số vai trò không phình ra: "kế toán kiêm tra cứu tiện ích" chỉ là thêm một nhóm chức năng vào vai trò, không phải tạo vai trò `ke_toan_tien_ich`.
- Một nơi trả lời "vai trò này dùng được gì": màn hình sửa vai trò.
- Không còn lấy phần giao nhau: quyền chỉ cộng dồn, chặn chỉ có một cách là chặn đích danh.
- Chỗ gắn phạm vi dòng sau này đã có sẵn.

### 3.6 Widget nhúng và mẫu nghiệp vụ (đã chốt 27/10)

**Widget nhúng**
- Mỗi widget có trường `role`, bắt buộc chọn. Mặc định là `khach_widget` (nhóm Cơ bản, không có SQL).
- Quyền của widget là quyền của vai trò đó: nguồn, gói bảng, mẫu nghiệp vụ. Widget không còn đường quyền riêng.
- Bỏ `embedIds` khỏi chính sách nguồn. Nhánh widget trong `canRead()` chuyển sang lấy vai trò của widget (`router.js:1183`, `router.js:1217`, `automation/runtime.js:46`).

**Mẫu nghiệp vụ**
- Mỗi mẫu có `access.mode` giống nguồn: `all` (mọi vai trò có `workflows.use`, mặc định, như hiện nay) hoặc `grants` (chỉ vai trò có nhóm chức năng chứa mẫu này). Trường `permissions` hiện có vẫn là quyền chức năng tối thiểu.
- Kiểm tra ở cả bốn đường: danh sách mẫu, chạy tay, qua MCP, qua widget (`automation/routes.js`, `automation/runtime.js`, `mcp_host_routes.js`, `router.js:1219`).
- Khi chạy, mẫu vẫn kiểm tra quyền dữ liệu của người chạy: nguồn qua `canRead`, bảng qua gói bảng.
- Khi thêm mẫu vào một nhóm chức năng, giao diện kiểm tra trước. Ví dụ: nhóm "Quản lý hợp đồng" không có gói "Tài chính & công nợ", nên bước 2 của mẫu "Đối soát công nợ" sẽ không chạy được.

### 3.7 Vai trò nào được truy vấn bảng nào — gói bảng theo nghiệp vụ

**Vì sao không cấp từng bảng.** Nguồn IPMS có 94 bảng. Cấp từng bảng là quản lý hàng trăm ô và rất dễ quên các bảng tra cứu đi kèm; kết quả là câu trả lời chỉ có mã mà thiếu tên, hoặc không nối được bảng. Vì vậy đơn vị cấp quyền là **gói bảng**: một nhóm bảng cùng nghiệp vụ, được đưa vào nhóm chức năng ở một trong hai mức.

| Mức | Được làm gì với bảng trong gói |
|---|---|
| **Đầy đủ** | Đọc mọi cột, trừ cột nhạy cảm |
| **Tra cứu** | Chỉ đọc khóa chính và cột hiển thị (tên, mã), đủ để câu trả lời có tên thay vì chỉ có mã |
| *(tự động)* **Cầu nối** | Chỉ dùng cột khóa trong điều kiện nối, không đọc được cột nào. Hệ thống tự cấp (quy tắc Q2) |

**Gói gợi ý cho IPMS** (dựa trên tiền tố tên bảng; admin sửa lại cho đúng nghiệp vụ):

| Gói | Bảng | Ghi chú |
|---|---|---|
| **Danh mục chung** *(gói nền)* | `M_Master`, `M_Constant`, `M_Company`, `M_IndustrialPark`, `M_Customer`, `M_Vendor`, `M_Price` | Tự cấp mức Đầy đủ cho mọi vai trò có `sql:read`, vì gần như mọi bảng nghiệp vụ đều trỏ tới (ví dụ `PeriodID` → `M_Master`) |
| **Nhân viên** | `M_Employee` | Mọi vai trò có `sql:read` tự có mức Tra cứu (mã, họ tên, phòng ban), vì nhiều bảng trỏ tới (người tạo, người phụ trách). Mức Đầy đủ qua nhóm chức năng Nhân sự |
| **Kinh doanh & xúc tiến** | `BS_Approach`, `BS_Negotiate`, `BS_Quote`, `BS_Survey` | |
| **Hợp đồng & cho thuê** | `T_Contract`, `T_ContractDetail`, `T_ContractLand`, `T_ContractPayment`, `T_LandFeeForRent`, `T_LandTaskForRent`, `T_LTFRentDetail`, `T_FactoryForRent`, `T_GasPipelineForRent`, `TER_Settlement`, `TER_Termination` | |
| **Tiện ích & vận hành** | `T_Electricity*` (4), `T_Water*` (2), `T_CNG*` (2), `T_Garbage*` (2), `T_Light*` (2), `T_Infrastructure*` (2), `T_OtherService` | |
| **Tài chính & công nợ** | `T_Revenue`, `T_RevenueDetail`, `T_CustomerDebt`, `T_VendorDebt`, `T_Expense`, `T_ExpenseDetail`, `T_VendorContract` | |
| **Phản hồi khách hàng** | `T_Feedback`, `T_FeedbackDetail` | |
| **Nhân sự** | `HR_*` (12 bảng) | Nhạy cảm: `HR_HealthInfo`, `HR_FamilyRelationship`, `HR_PassportInfo`, `HR_Discipline` |
| **Chấm công** | `TS_*` (10 bảng) | |
| **Lương & bảo hiểm** | `PR_*` (7), `SI_*` (3) | Rất nhạy cảm |
| **Hệ thống** *(ẩn)* | `S_*` (14 bảng), `M_DataLock` | Nằm trong `hiddenTables`: ẩn khỏi AI với **mọi** vai trò, kể cả admin, và không bao giờ làm cầu nối. `S_User_OTP`, `S_ESign`, `S_FCM` chứa mã xác thực và mã thiết bị |

Tổng: 7 + 1 + 4 + 11 + 15 + 7 + 2 + 12 + 10 + 10 + 15 = 94 bảng, khớp danh mục lược đồ hiện có.

**Ví dụ ma trận gói bảng × nhóm chức năng** (admin chốt lại):

| Gói \ Nhóm chức năng | Tra cứu hợp đồng | Quản lý hợp đồng | Tài chính & công nợ | Vận hành tiện ích | Nhân sự | Lương & BH |
|---|---|---|---|---|---|---|
| Kinh doanh & xúc tiến | — | Đầy đủ | — | — | — | — |
| Hợp đồng & cho thuê | Tra cứu | Đầy đủ | — | — | — | — |
| Tiện ích & vận hành | — | — | — | Đầy đủ | — | — |
| Tài chính & công nợ | — | — | Đầy đủ | — | — | — |
| Phản hồi khách hàng | — | — | — | Đầy đủ | — | — |
| Nhân sự | — | — | — | — | Đầy đủ | Tra cứu |
| Chấm công | — | — | — | — | Đầy đủ | Đầy đủ |
| Lương & bảo hiểm | — | — | — | — | — | Đầy đủ |

Ghép với bảng vai trò ở mục 3.5: vai trò Kế toán có Tài chính (Đầy đủ) và Hợp đồng (Tra cứu); vai trò Quản lý có Hợp đồng, Kinh doanh, Tài chính, Tiện ích, Phản hồi (đều Đầy đủ).

**Quy tắc để không bị chặn hay thiếu trường**

| # | Quy tắc | Khác hiện nay ở đâu |
|---|---|---|
| Q1 | **Tự thêm bảng tra cứu.** Khi một vai trò có một gói, mọi bảng mà gói trỏ tới qua quan hệ nhiều-một đã xác minh (khóa ngoại → danh mục) được cấp mức Tra cứu nếu chưa có mức cao hơn. Nhờ vậy câu trả lời có tên khách hàng, tên nhân viên thay vì chỉ có mã. | Hiện chỉ có `allowedTables` chung, không biết bảng nào đi kèm bảng nào |
| Q2 | **Bảng cầu nối.** Nếu đường nối A → X → B có A và B được đọc nhưng X thì không, X được dùng ở mức Cầu nối: chỉ cột khóa trong `ON`. Bảng trong `hiddenTables` không bao giờ làm cầu nối. Với gói nhạy cảm, admin chọn có cho làm cầu nối hay không (mặc định *có*, vì chỉ dùng khóa). | Hiện bảng ngoài `allowedTables` khiến đường nối bị bỏ hẳn |
| Q3 | **Cột bị chặn không làm gãy quan hệ.** Cột nhạy cảm không được nằm trong `SELECT`, `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, nhưng **được** nằm trong `ON a.k = b.k` khi cặp cột đó là quan hệ đã xác minh. Khóa chính và khóa ngoại không được đánh dấu nhạy cảm; giao diện cảnh báo nếu admin thử. | `join_path.js:40` bỏ cả quan hệ khi cột khóa bị chặn; `sql_policy.js:15` chặn cột ở mọi vị trí |
| Q4 | **Chặn cột theo bảng.** Ghi `Bang.Cot`. Tên cột trần vẫn dùng được, giao diện ghi rõ là "mọi bảng". | Hiện chặn `Amount` là chặn ở mọi bảng (`sql_policy.js:13-15`, `query_catalog.js:28`) |
| Q5 | **`SELECT *` không còn bị từ chối.** Máy chủ tự đổi `*` thành danh sách cột được phép của bảng, lấy từ danh mục lược đồ. Chỉ từ chối, kèm thông báo rõ, khi không đổi được (truy vấn con, CTE). | Hiện từ chối mọi `SELECT *` khi nguồn có cột bị chặn |
| Q6 | **AI chỉ thấy phạm vi của người hỏi.** `query_catalog.build()` lọc theo phạm vi thực tế: bảng Đầy đủ có đủ cột, bảng Tra cứu chỉ có khóa và cột hiển thị, bảng Cầu nối chỉ có khóa. AI không viết câu dùng bảng ngoài phạm vi, nên ít bị chặn sau khi đã sinh SQL. | Hiện catalog chỉ lọc theo chính sách chung của nguồn |
| Q7 | **Báo đúng lý do khi thiếu quyền.** Ví dụ: "Vai trò của bạn chưa có gói *Tài chính & công nợ* nên chưa xem được công nợ." | Hiện là lỗi chung `SQL_TABLE_DENIED` |
| Q8 | **Chỉ tiêu và mẫu nghiệp vụ theo phạm vi.** Chỉ tiêu dùng bảng ngoài phạm vi của vai trò thì bị ẩn với vai trò đó. Mẫu nghiệp vụ được kiểm tra khi thêm vào nhóm chức năng (mục 3.6). | Hiện chỉ tiêu hiện với mọi người đọc được nguồn |

**Kiểm tra độ phủ** (chạy ngay khi sửa nhóm chức năng hoặc ma trận, không gọi AI). Với từng vai trò, liệt kê:
- Bảng được cấp có khóa ngoại trỏ tới bảng không có cột hiển thị → "sẽ chỉ hiện mã". Đề xuất: khai báo cột hiển thị cho quan hệ.
- Hai bảng trong cùng gói chưa có quan hệ đã xác minh → "không nối được", kèm liên kết sang trang Lược đồ để xác minh.
- Cột nhạy cảm đang là khóa → lỗi cấu hình.
- Chỉ tiêu hoặc mẫu nghiệp vụ không chạy được với vai trò.
- Bảng chưa thuộc gói nào → "bảng mồ côi": chỉ admin hỏi được.

**Lưu ý về dữ liệu quan hệ.** Tệp `data/table_relationships.json` ở máy này đang trống. Nếu quan hệ đã xác minh nằm ở PostgreSQL thì dùng nguồn đó. Nếu thật sự chưa có quan hệ nào, cần xác minh quan hệ cho các bảng chính trước, vì Q1, Q2 và kiểm tra độ phủ đều dựa vào đó.

**Lưu trữ và nơi áp dụng**
- Trên nguồn: `sql.packages`: `[{ id, name, tables: [tableId], sensitiveColumns: ["Bang.Cot"], allowBridge: true, base: false }]` và `sql.hiddenTables`.
- Trên nhóm chức năng: `packages: { "<sourceId>": { "<packageId>": "full" | "lookup" } }` (mục 3.5).
- `allowedTables` cũ được giữ làm **trần chung** của nguồn; gói không vượt quá được.
- Gợi ý gói tự động: khi nguồn chưa có gói, hệ thống đề xuất theo tiền tố tên bảng và cụm quan hệ; admin sửa rồi lưu. Cấu hình chỉ chứa tên bảng và tên cột, không chứa giá trị dữ liệu thật; lưu trong kho của ứng dụng, không ghi vào SQL Server.
- Hàm mới `governance/scope.js` `effectiveScope(source, actor)` trả về `{ tableId → full | lookup | bridge, cột được đọc }`. Kết quả được nhớ theo (revision nguồn, revision vai trò, revision các nhóm chức năng). Dùng ở: `query_catalog.build()`, `join_path.execute()` / `relationship_service.verifiedRelationships()`, `sql_policy.check()` (đổi sang kiểm tra theo từng mệnh đề trên cây cú pháp và tự đổi `*`), `governance/metrics.js`, các bước SQL của mẫu nghiệp vụ.
- **Bộ nhớ đệm:** hai người hỏi cùng một nguồn giờ có thể thấy phạm vi bảng khác nhau. Khóa đệm của harness (`summary()` → `policyRevision`) phải thêm mã băm của phạm vi thực tế, không chỉ phiên bản chính sách của nguồn.

## 4. Giao diện mới

Trang **Quản trị dữ liệu** chia thành các thẻ:

### 4.1 Thẻ "Nguồn dữ liệu" (mặc định)

Một bảng chung cho SQL và tài liệu:

| ☐ | Tên | Loại | Mở cho | Chia sẻ AI | Gói bảng | Kế thừa | Cập nhật |
|---|---|---|---|---|---|---|---|
| ☐ | IPMS | SQL | 🟢 Mọi người | 🟢 Tất cả AI | 11 gói · 15 bảng ẩn | — | 27/10 · admin |
| ☐ | HDSD.pdf | Tài liệu | 🟡 3 nhóm chức năng | 🟠 Chỉ cục bộ | — | Thư mục "HDSD" | … |

- Bộ lọc theo loại, thư mục theo dõi, mức chia sẻ AI, chế độ mở; có ô tìm theo tên.
- **Sửa hàng loạt**: chọn nhiều dòng rồi dùng "Đặt chia sẻ AI…" hoặc "Đặt chế độ mở…". Thao tác là tất cả hoặc không, và dừng nếu có nguồn đã bị người khác sửa.
- Bấm vào một dòng để mở **ngăn chi tiết** bên phải:
  - **Mở cho ai**: 3 lựa chọn (Mọi người / Theo nhóm chức năng / Chỉ admin). Với "Theo nhóm chức năng", hiện danh sách nhóm đang chứa nguồn này, có thể thêm hoặc bớt tại chỗ. Thêm phần "Ngoại lệ: cấp thêm người… / chặn người…".
  - **Chia sẻ AI**: 3 nút (Tất cả AI / Chỉ AI cục bộ / Tắt AI), kèm dòng giải thích lấy từ danh sách provider thật, ví dụ "Hiện gồm: Gemini ×3, Ollama ×2". Phần "Nâng cao: loại trừ provider" mặc định thu gọn.
  - **Gói bảng** (chỉ SQL): danh sách gói của nguồn. Mỗi gói có bảng (chọn từ danh mục lược đồ, có tìm kiếm), cột nhạy cảm (chọn theo bảng; cột khóa bị khóa lại kèm giải thích), tùy chọn "cho làm cầu nối" và dòng "Dùng trong nhóm chức năng: …". Nút "Gợi ý gói" dùng khi nguồn chưa có gói. Bên dưới là danh sách bảng ẩn và bảng mồ côi.
  - Chân ngăn: thông báo đã lưu hoặc lỗi (giữ cách làm hiện tại), phiên bản, người sửa cuối.

### 4.2 Thẻ "Nhóm chức năng"

- Danh sách nhóm chức năng: tên, số quyền, số gói bảng, số mẫu nghiệp vụ, "dùng trong N vai trò".
- **Trình sửa nhóm chức năng** gồm bốn phần:
  1. Quyền chức năng (hộp kiểm như trang Tài khoản hiện nay).
  2. Nguồn và tài liệu (chỉ hiện các nguồn đặt "Theo nhóm chức năng").
  3. Gói bảng theo nguồn, mỗi gói chọn — / Tra cứu / Đầy đủ.
  4. Mẫu nghiệp vụ (chỉ hiện các mẫu đặt "Theo nhóm chức năng").

  Trước khi lưu, hiện ảnh hưởng: "Áp dụng cho vai trò Kế toán, Quản lý · 12 tài khoản".
- Nút **"Xem dạng ma trận"**: bảng gói bảng × nhóm chức năng như ví dụ ở mục 3.7. Sửa trực tiếp từng ô và lưu một lần.
- Bên cạnh là bảng **kiểm tra độ phủ** theo vai trò (mục 3.7), tự cập nhật mỗi khi đổi, chưa cần lưu.

### 4.3 Thẻ "Kiểm tra quyền"

Chọn một tài khoản, vai trò hoặc widget, hệ thống liệt kê:
- Nhóm chức năng đang có, và mỗi nhóm đến từ đâu (vai trò hay bổ sung riêng).
- Từng nguồn: đọc được ✓ / ✗ kèm **lý do**, ví dụ "nhờ nhóm *Tài chính & công nợ* của vai trò *Kế toán*", "bị chặn đích danh", "thiếu quyền chức năng `sql:read`".
- Model đang chọn có nhận được dữ liệu không, ví dụ "Gemini: ✓ · Ollama: ✓".
- Với nguồn SQL: bảng theo mức (Đầy đủ / Tra cứu / Cầu nối), chỉ tiêu dùng được, mẫu nghiệp vụ chạy được.
- Ô "Thử câu SQL": chỉ chạy `sql_policy.check()` theo phạm vi của người đó và báo bảng hoặc cột nào bị chặn. Không chạy truy vấn thật.

Đây là chỗ trả lời câu hỏi "vì sao người X không hỏi được dữ liệu Y" mà không phải đọc nhật ký.

### 4.4 Thẻ "Chỉ tiêu SQL"

Giữ chức năng hiện tại. Thay ô JSON bằng biểu mẫu: chọn bảng, cột giá trị, phép tính, cột thời gian và các chiều phân nhóm từ danh mục lược đồ. Vẫn có nút "Xem JSON". Phần này làm cuối (giai đoạn 4).

### 4.5 Thay đổi ở trang khác

- **Tài khoản → Vai trò**: trình sửa vai trò chỉ còn tên, mô tả và **chọn nhóm chức năng** (chọn nhiều), kèm khung xem trước quyền tổng hợp: số quyền, nguồn, gói bảng, mẫu nghiệp vụ. Bỏ khối chọn quyền và "Nguồn SQL / Tài liệu được phép" (`renderPermissionChecks`, `renderDataAccess`, `readDataAccess` trong `accounts.js`).
- **Tài khoản → Tài khoản**: chọn vai trò và (tùy chọn) "Nhóm chức năng bổ sung". Bỏ "Phân quyền riêng cho tài khoản". Thêm một dòng tóm tắt "Đọc được 2/2 nguồn SQL, 4/4 tài liệu → Kiểm tra quyền".
- **Thư mục theo dõi**: thêm "Chính sách cho tài liệu của thư mục" (Mở cho ai + Chia sẻ AI).
- **Thư viện**: mỗi tài liệu có huy hiệu chia sẻ AI; bấm vào để mở ngăn chi tiết.
- **AI Providers**: thêm công tắc "Không nhận dữ liệu nội bộ" (`rejectInternalData`).
- **Widget nhúng**: thêm ô chọn "Vai trò của widget" (bắt buộc), kèm dòng tóm tắt quyền.
- **Mẫu nghiệp vụ**: thêm "Ai được dùng: Mọi người / Theo nhóm chức năng", kèm danh sách nhóm đang chứa mẫu.
- **Khối "Chất lượng và vận hành Agent"**: chuyển sang trang Tổng quan hoặc Báo cáo, vì không liên quan đến phân quyền dữ liệu.

## 5. API

| Phương thức | Đường dẫn | Ghi chú |
|---|---|---|
| GET | `/api/governance/resources` | Trả `policy` đã chuẩn hóa sang v2, `effectiveSummary` (chế độ mở, số nhóm chức năng chứa nguồn, mức AI) và danh mục kèm theo: `providers` (tên, cục bộ, `rejectInternalData`), `functionGroups`, `roles`, `users` (id, tên), `watchfolders` |
| PUT | `/api/governance/resources` | Thân `{ type, id, expectedRevision, policy }` theo schema v2. Trong một phiên bản chuyển tiếp vẫn nhận v1 và đổi sang v2 |
| POST | `/api/governance/resources/bulk` | `{ items:[{type,id,expectedRevision}], patch:{ access?, aiSharing? } }`. Tất cả hoặc không; trả 409 kèm danh sách nguồn bị xung đột |
| GET/POST/PUT/DELETE | `/api/accounts/function-groups[/:id]` | Thêm, sửa, xóa nhóm chức năng; có `revision`. Xóa bị từ chối khi nhóm còn được vai trò dùng. PUT trả kèm `impact` (vai trò, số tài khoản) |
| POST | `/api/accounts/function-groups/matrix` | Lưu ma trận gói × nhóm chức năng một lần; tất cả hoặc không |
| PUT | `/api/accounts/roles/:id` | Thân `{ name, description, functionGroups, revision }` |
| PUT | `/api/accounts/:id` | Thêm `extraFunctionGroups`; bỏ `permissions` / `dataAccess` riêng |
| GET | `/api/governance/effective?subject=account:ID` · `?role=ID` · `?embed=ID` | Kết quả cho thẻ Kiểm tra quyền, có lý do cho từng nguồn |
| GET | `/api/governance/sql/:sourceId/package-suggestions` | Gợi ý gói theo tiền tố và cụm quan hệ; chỉ trả về, không ghi |
| POST | `/api/governance/coverage` | Thân là nhóm chức năng hoặc ma trận đang sửa (chưa lưu); trả kết quả kiểm tra độ phủ theo vai trò |
| POST | `/api/governance/sql/:sourceId/check-query` | `{ subject, sql }` → chạy `sql_policy.check()` theo phạm vi người đó; không chạy truy vấn thật |
| PUT | `/api/watchfolders/:id` | Thêm `defaultPolicy` |
| PUT | `/api/embed-configs/:id` | Thêm `role` |
| PUT | `/api/workflows/:id` | Thêm `access.mode` |

Mọi API quản trị vẫn chỉ admin dùng được (`governance/routes.js:14`, nhánh `/api/accounts/*` trong `router.js`).

## 6. Chuyển đổi dữ liệu

Viết script `scripts/migrate_governance_v2.js` với hai chế độ: `--dry-run` (mặc định, in báo cáo) và `--apply` (sao lưu vào `data/backup/` rồi ghi).

**Nguồn và tài liệu**

| Dữ liệu cũ | Chuyển thành |
|---|---|
| Không có chính sách | Không ghi gì; khi đọc dùng mặc định v2 (`all` / `all`) |
| `visibility: shared` | `access.mode = all` |
| `visibility: restricted` + `roles` | `access.mode = grants`; nguồn được thêm vào nhóm chức năng chuyển đổi của từng vai trò đó |
| `visibility: restricted` + `subjects` | `access.users = subjects` |
| `embedIds` | Mỗi widget có trong danh sách: tạo vai trò `widget_<mã>` gồm nhóm chức năng có đúng các nguồn đó, rồi gán `role` cho widget. Widget không có trong danh sách nào: gán `khach_widget` |
| `sensitivity: public` | `aiSharing.level = all` |
| `sensitivity: internal` | `all` (theo yêu cầu mới); ghi rõ trong báo cáo để admin xem lại |
| `sensitivity: restricted` | `local`; nếu trước đó có provider cloud trong danh sách thì ghi chú cần xem lại |
| `allowedTables` | Giữ làm trần chung. Nếu nguồn chưa có gói: tạo **một gói "Toàn bộ (chuyển đổi)"** gồm các bảng trong trần, rồi thêm gói ở mức Đầy đủ vào nhóm chức năng chuyển đổi của mọi vai trò đang đọc được nguồn. Nhờ vậy không ai bị đổi phạm vi bảng; admin chia gói sau |
| `blockedColumns` (tên trần) | `sensitiveColumns` dạng "mọi bảng" của gói "Toàn bộ"; cột khóa bị bỏ khỏi danh sách và ghi vào báo cáo (theo Q3) |

**Vai trò và tài khoản**

| Dữ liệu cũ | Chuyển thành |
|---|---|
| Vai trò (kể cả `user` hệ thống) có `permissions` và `dataAccess` | Tạo một nhóm chức năng "<Tên vai trò> (chuyển đổi)" chứa đúng các quyền đó. Nếu `dataAccess.sql` / `documents` là danh sách thì các nguồn ngoài danh sách chuyển sang `grants`, và nhóm chứa các nguồn trong danh sách. Vai trò dùng đúng nhóm này |
| Tài khoản có `permissions` riêng | Quyền rộng hơn vai trò: tạo nhóm "Bổ sung: <tài khoản>" chứa phần quyền thêm, đưa vào `extraFunctionGroups`. Quyền hẹp hơn vai trò: tạo vai trò riêng `rieng_<mã>` có nhóm chứa đúng các quyền đó, và ghi vào báo cáo |
| Tài khoản có `dataAccess` thu hẹp | Thêm tài khoản vào `denyUsers` của các nguồn bị loại |
| Mẫu nghiệp vụ | `access.mode = all` (như hiện nay) |

**Điều kiện chấp nhận:** chạy dry-run, so sánh quyền cũ và mới cho mọi cặp (tài khoản × nguồn) và (tài khoản × quyền chức năng). **Không được có cặp nào đổi kết quả.** Riêng chia sẻ AI được phép rộng hơn, vì đó là yêu cầu. Dữ liệu hiện tại có 2 nguồn SQL, 4 tài liệu, chưa có chính sách nào, chưa có vai trò tùy chỉnh và chỉ 1 tài khoản admin, nên thực tế lần này chỉ tạo nhóm "Người dùng (chuyển đổi)" cho vai trò `user`.

**Đọc song song:** `policy.normalize()` đọc được cả v1 và v2 trong một phiên bản, rồi mới bỏ v1. `permissions` / `dataAccess` cũ trên vai trò và tài khoản vẫn được nhận nhưng bị bỏ qua (có ghi cảnh báo) trong một phiên bản, rồi mới xóa.

## 7. Các giai đoạn

### Giai đoạn 0 — Nền tảng (không đổi hành vi)
- Thêm `src/backend/governance/policy.js`: `normalize()`, `defaults(type)`, `canRead()`, `canSend()`, `destination()`, `explain()`. Đều là hàm thuần, không phụ thuộc kho dữ liệu.
- `context.js` gọi qua `policy.js`. Kiểm thử hồi quy (`governance_policy.test.js`, `governance_routes.test.js`, `account_roles_permissions.test.js`) phải vẫn đạt.

### Giai đoạn 1 — Chia sẻ AI (yêu cầu 1, 2) · làm trước vì hết bị chặn ngay
- `aiSharing` với mặc định `all`; phân loại đích (mục 3.3); cờ `rejectInternalData` cho provider; công tắc chung cho `mcp` và `api`; tìm kiếm web bỏ kiểm tra gửi dữ liệu.
- Chính sách mặc định cho thư mục theo dõi, tài liệu kế thừa thư mục (mục 3.4).
- `rag/signal.js` giữ nguyên cách gọi `canSend`, chỉ đổi ý nghĩa.
- Viết lại thông báo lỗi trong `governance/context.js` (dòng 40 cho widget, dòng 67 cho đích xử lý).
- Giao diện tạm: thay ô "Đích xử lý" bằng 3 nút chia sẻ AI, bỏ ô "Mức nhạy cảm".
- **Xong khi:** hỏi SQL và RAG bằng Gemini chạy được mà không phải cấu hình gì; đặt "Chỉ AI cục bộ" thì Gemini bị chặn còn Ollama chạy; đặt "Tắt AI" thì nguồn không còn xuất hiện.

### Giai đoạn 2 — Vai trò và nhóm chức năng (yêu cầu 3)
- `account_function_groups` (lưu trữ, có bản PostgreSQL), vai trò dùng `functionGroups`, tài khoản dùng `extraFunctionGroups`, hàm `effective()`.
- `access` của nguồn với chế độ `all`, `grants`, `admin`, cùng `users` / `denyUsers`. Script chuyển đổi ở mục 6.
- Bỏ `dataAccess` khỏi `router.js:387/390`, `mcp_host_routes.js:85`, `automation/runtime.js:50/125/234`, `automation/routes.js:110`. `runtime.visible()` chuyển sang `canRead` cho các nguồn gắn vào mẫu nghiệp vụ.
- `account_access.allowed()` và `permissionsForAccount()` lấy quyền chức năng từ `effective()`.
- Widget theo vai trò; mẫu nghiệp vụ có `access.mode` (mục 3.6).
- API nhóm chức năng, vai trò, `effective`.
- **Xong khi:** kiểm tra so sánh cũ/mới ở mục 6 đạt; mọi kênh (trò chuyện, MCP, mẫu nghiệp vụ, widget) đều đi qua `effective()` và `canRead()`.

### Giai đoạn 2b — Gói bảng (mục 3.7)
- Kiểm tra trước: quan hệ đã xác minh có trong PostgreSQL không. Nếu chưa có, xác minh quan hệ cho các bảng chính trước khi làm Q1 và Q2.
- `sql.packages`, `sql.hiddenTables`, gói trong nhóm chức năng, `governance/scope.js` `effectiveScope()`.
- Áp dụng ở `query_catalog.build()`, `join_path`, `relationship_service`, `sql_policy.check()` (kiểm tra theo mệnh đề, cho phép cột khóa trong `ON`, tự đổi `*`), chỉ tiêu và mẫu nghiệp vụ.
- Thêm mã băm phạm vi vào khóa đệm của harness.
- API gợi ý gói, kiểm tra độ phủ, thử câu SQL.
- **Xong khi:**
  - Với ví dụ ở mục 3.5 và 3.7: vai trò Kinh doanh hỏi "hợp đồng của khách hàng X" thì có tên khách hàng (Q1); hỏi "công nợ chi tiết" thì nhận thông báo thiếu gói (Q7).
  - Vai trò Kế toán nối được hợp đồng với doanh thu qua bảng trung gian (Q2).
  - Không vai trò nào truy vấn được `S_User_OTP`.
  - Sau chuyển đổi, mọi câu SQL trước đây chạy được thì vẫn chạy được.

### Giai đoạn 3 — Giao diện mới (yêu cầu 4)
- Viết lại `views/data_governance.html`. Tách `js/modules/governance.js` thành `governance/sources.js` (bảng, ngăn chi tiết, sửa hàng loạt), `governance/function_groups.js` (danh sách, trình sửa, ma trận, độ phủ), `governance/inspect.js`, `governance/metrics.js`. CSS thêm vào `css/settings.css` theo các lớp `settings-governance-*` sẵn có.
- Trang Tài khoản, Thư mục theo dõi, Thư viện, AI Providers, Widget, Mẫu nghiệp vụ đổi theo mục 4.5.
- Chuyển khối vận hành Agent sang trang khác.
- Cập nhật `tests/governance_loading.test.js`, `governance_save_feedback.test.js`, `frontend_tab_loading.test.js`, `account_roles_permissions.test.js`.
- **Xong khi:** làm được mọi thao tác ở mục 4 mà không phải gõ mã nào; dùng được trên màn hình hẹp; đọc được bằng trình đọc màn hình (giữ `role=status/alert` như hiện tại).

### Giai đoạn 4 — Chỉ tiêu và phạm vi dòng (tùy chọn)
- Biểu mẫu chỉ tiêu thay cho JSON.
- Nối với kế hoạch lọc theo dòng: `scopeAttributes` đặt trên nhóm chức năng, ghép bằng phép hợp như các quyền khác.

## 8. Kiểm thử

| Loại | Nội dung |
|---|---|
| Đơn vị (`governance_policy.test.js`) | Bảng các trường hợp: admin / widget theo vai trò / thiếu quyền chức năng / bị chặn đích danh / ba chế độ mở / ba mức AI × các loại đích / provider có `rejectInternalData` / tài liệu kế thừa thư mục / web luôn được |
| Nhóm chức năng (`account_function_groups.test.js`, mới) | Ghép bằng phép hợp; lấy mức cao nhất khi hai nhóm cấp cùng gói; nhóm bổ sung của tài khoản; xóa nhóm đang dùng bị từ chối; lệch `revision` trả 409; đổi nhóm thì quyền đổi ngay ở lượt sau |
| Phạm vi bảng (`governance_scope.test.js`, mới) | Đầy đủ / Tra cứu / Cầu nối; tự thêm bảng tra cứu; bảng ẩn không làm cầu nối; cột nhạy cảm trong `ON` được, trong `SELECT` / `WHERE` / `GROUP BY` / `ORDER BY` / `HAVING` bị chặn; khóa không đánh dấu nhạy cảm được; tự đổi `SELECT *`; khóa đệm khác nhau giữa hai vai trò |
| Chuyển đổi | Bộ dữ liệu mẫu v1 (vai trò có `dataAccess`, tài khoản có quyền riêng rộng hơn và hẹp hơn, widget có `embedIds`); so sánh quyền cũ/mới cho mọi cặp |
| Hồi quy SQL | Chạy lại bộ câu SQL trong `tests/` và `eval:schema` với gói "Toàn bộ (chuyển đổi)": kết quả phải giống trước |
| Widget và mẫu nghiệp vụ | Widget đọc theo vai trò được gán; mẫu đặt "Theo nhóm chức năng" bị từ chối với vai trò không có, ở cả bốn đường |
| Tuyến API (`governance_routes.test.js`) | Schema v2, nhận v1 trong giai đoạn chuyển tiếp, 409 khi lệch phiên bản, sửa hàng loạt tất cả hoặc không, `effective` |
| Đường chạy | SQL qua `sql_connector` → `assertEgress` với provider cloud và cục bộ; RAG `routableDocuments`; MCP; tìm kiếm web khi đã đọc SQL |
| Giao diện | Tải trang, sửa một nguồn, sửa hàng loạt, sửa nhóm chức năng, ma trận, kiểm tra quyền, sửa vai trò; xem trong trình duyệt trước khi bàn giao |
| Chạy thật | Một câu SQL và một câu RAG trên "Google Gemini - Payment", mỗi câu một lần sau giai đoạn 1; một câu theo vai trò Kinh doanh sau giai đoạn 2b |

## 9. Rủi ro và cách xử lý

| Rủi ro | Cách xử lý |
|---|---|
| Mặc định "Tất cả AI" làm dữ liệu nội bộ ra provider cloud nhiều hơn | Đây là yêu cầu. Bù lại bằng: nút "Tắt AI" / "Chỉ cục bộ" một chạm, sửa hàng loạt, cờ `rejectInternalData` cho provider chưa tin cậy, nhật ký mỗi lần đổi chính sách |
| Sửa một nhóm chức năng ảnh hưởng nhiều vai trò cùng lúc | Hiện ảnh hưởng (vai trò, số tài khoản) trước khi lưu; mỗi lần sửa tăng `revision` và ghi người sửa |
| Phép hợp không trừ bớt được quyền | Dùng chặn đích danh (`denyUsers`) hoặc bảng ẩn; nếu cần hẹp hơn hẳn thì tạo vai trò riêng |
| Quá nhiều nhóm chức năng nhỏ, khó quản | Giao diện hiện "dùng trong N vai trò" và cảnh báo nhóm không vai trò nào dùng; mỗi nhóm nên ứng với một việc nghiệp vụ, không phải một bảng |
| Widget công khai đọc được dữ liệu | Widget mới mặc định `khach_widget`, không có SQL; muốn widget đọc SQL thì admin phải gán vai trò khác |
| Tìm kiếm web mang theo dữ liệu nội bộ trong câu tìm kiếm | Đã chốt cho phép mọi người dùng. Câu tìm kiếm được ghi nhật ký; nếu sau này cần siết thì thêm công tắc chung, không phải đổi mô hình |
| Cột hoặc bảng nhạy cảm lộ qua bảng cầu nối hoặc điều kiện lọc | Cầu nối chỉ dùng khóa trong `ON`; cột nhạy cảm bị cấm cả trong `WHERE` / `GROUP BY` / `ORDER BY` / `HAVING`; bảng ẩn không bao giờ làm cầu nối |
| Gói gợi ý sai nghiệp vụ | Gợi ý chỉ là bản nháp; chuyển đổi dùng gói "Toàn bộ" nên chưa ai bị đổi quyền cho tới khi admin chia gói |
| Thiếu quan hệ đã xác minh làm Q1, Q2 không chạy | Kiểm tra độ phủ báo ngay "không nối được"; xác minh quan hệ trước giai đoạn 2b |
| Chuyển đổi làm đổi quyền | Dry-run, kiểm tra so sánh, sao lưu trước khi ghi, đọc được cả bản cũ và mới trong một phiên bản |
| Đệm kết quả cũ sau khi đổi quyền | Khóa đệm gồm revision nguồn, vai trò và nhóm chức năng cùng mã băm phạm vi; tài liệu kế thừa thư mục dùng `revision` gộp của tài liệu và thư mục |

## 10. Quyết định

**Đã chốt (27/10)**
1. **Tìm kiếm web** là tiện ích mở rộng, mọi người dùng được, không gắn với chính sách nguồn.
2. **Widget và mẫu nghiệp vụ** theo vai trò: widget được gán một vai trò; mẫu nghiệp vụ mở cho mọi người hoặc theo nhóm chức năng.
3. **Quản lý theo vai trò, vai trò được ghép từ nhóm chức năng.** Bỏ "nhóm dữ liệu" riêng.

**Đã chốt theo đề xuất (27/10):** các điểm 6–9 bên dưới làm theo phương án đề xuất.

**Còn cần chốt**
4. **Gói bảng** ở mục 3.7 có đúng nghiệp vụ không? Đặc biệt: `BS_*` có tách khỏi Hợp đồng không; `TER_*` thuộc Hợp đồng hay Tài chính?
5. **Danh sách nhóm chức năng và vai trò thật** bên bạn. Các bảng ở mục 3.5 và 3.7 chỉ là ví dụ.
6. **`M_Employee` ở mức Tra cứu** gồm những cột nào? Đề xuất: mã, họ tên, phòng ban, chức vụ.
7. **Gói nhạy cảm (Nhân sự, Lương) có được làm cầu nối không?** Đề xuất *có*, vì chỉ dùng khóa.
8. **Nhóm chức năng bổ sung cho từng tài khoản:** đề xuất *có*, để cấp thêm cho một người mà không phải tạo vai trò mới.
9. **Provider thêm sau này** tự động nhận dữ liệu của các nguồn đặt "Tất cả AI": đề xuất *có*, chặn bằng cờ `rejectInternalData` trên provider.

## 11. Trạng thái triển khai (27/10)

**Đã làm:** giai đoạn 0, 1, 2, 2b, 3 và script chuyển đổi.

| Phần | Vị trí |
|---|---|
| Luật thuần (đọc v1/v2, quyền đọc, gửi AI, phân loại đích) | `src/backend/governance/policy.js` |
| Phạm vi bảng theo gói (Đầy đủ / Tra cứu / Cầu nối, bảng ẩn, cột nhạy cảm) | `src/backend/governance/scope.js` |
| Kiểm tra SQL theo mệnh đề, tự đổi `SELECT *` | `src/backend/governance/sql_policy.js` |
| Nhóm chức năng; vai trò ghép nhóm; nhóm bổ sung cho tài khoản; vai trò `khach_widget` | `services/account_function_groups.js`, `services/account_roles.js`, `services/auth_service.js` |
| API quản trị (nguồn, sửa hàng loạt, nhóm chức năng, ma trận, độ phủ, kiểm tra quyền, gợi ý gói, thử câu SQL) | `src/backend/governance/routes.js` |
| Chuyển đổi dữ liệu | `src/backend/governance/migration.js`, `npm run migrate:governance-v2` |
| Bảng PostgreSQL mới | `migrations/postgres/010_account_function_groups.sql` (đã chạy `npm run db:migrate`) |
| Giao diện | `views/data_governance.html`, `js/modules/governance.js`, `js/modules/governance_groups.js`, `css/data-governance.css`; trang Tài khoản, Embed Chat, AI Providers |

**Khác với bản plan ở trên:**
- API nhóm chức năng nằm ở `/api/governance/function-groups` (không phải `/api/accounts/function-groups`).
- Chuyển đổi **không** tạo gói “Toàn bộ (chuyển đổi)”: nguồn chưa có gói vẫn mở mọi bảng như hiện nay. Gói chỉ có hiệu lực khi admin lưu gói đầu tiên; giao diện hỏi xác nhận trước khi lưu.
- `khach_widget` chỉ có quyền `chat.use`, đúng với quyền hiện tại của widget chưa được cấp nguồn. Quyền widget kiểu cũ (`embedIds`) được giữ nguyên và báo trong kết quả chuyển đổi để admin gán vai trò sau.
- Cột nhạy cảm của gói chỉ admin đọc được.
- Mẫu nghiệp vụ: đặt “Ai được dùng” ngay trong trình sửa nhóm chức năng (gọi `/api/workflow-plugins/:id/access`).
- Khối “Vận hành Agent” là một thẻ riêng trong trang thay vì chuyển sang trang khác.
- Chính sách thư mục theo dõi sửa ở thẻ Nguồn dữ liệu (loại “Thư mục theo dõi”); chưa thêm nút trên trang Thư mục theo dõi và huy hiệu trên trang Thư viện.

**Chưa làm / cần bạn chạy:**
- Khởi động lại máy chủ để nạp mã mới.
- `npm run migrate:governance-v2` (chạy thử, đã kiểm tra trên dữ liệu thật: 0 sai lệch) rồi `npm run migrate:governance-v2 -- --apply`. Chưa chạy `--apply`; mã mới vẫn đọc được chính sách cũ.
- Quan hệ bảng đã xác minh: cần có trước khi chia gói, để tự thêm bảng tra cứu và nối qua bảng cầu nối.
- Giai đoạn 4: biểu mẫu chỉ tiêu thay JSON, phạm vi dòng.

## 12. Quyết định và áp dụng trên dữ liệu thật (28/10)

**Các điểm còn lại ở mục 10 (chốt theo đề xuất):**
- `BS_*` là gói riêng “Kinh doanh & xúc tiến”; `TER_*` thuộc “Hợp đồng & cho thuê”.
- `M_Employee` ở mức Tra cứu chỉ hiện `EmployeeID`, `EmployeeCode`, `EmployeeName`, `DepartmentID`, `TitleID`, `CompanyID`. Gói không khai báo cột tra cứu thì tự chọn cột tên và mã, không bao giờ chọn cột thuế, ngân hàng, giấy tờ, liên lạc, lương.
- Gói Nhân sự và Lương được làm cầu nối (chỉ dùng khóa).
- Chưa tạo vai trò theo phòng ban, vì chưa có tài khoản thật nào ngoài admin. Đã tạo sẵn 8 nhóm chức năng mẫu để ghép khi cần: Cơ bản, Tra cứu hợp đồng, Quản lý hợp đồng, Tài chính & công nợ, Vận hành tiện ích, Nhân sự, Lương & bảo hiểm, Báo cáo quản trị.

**Đã áp dụng cho IPMS** (sao lưu ở `data/backup/governance-packages-2026-10-27T17-25-40-793Z`):
- 10 gói, đủ 94 bảng (kể cả 53 bảng đang tắt): Danh mục chung 7 (nền, Đầy đủ), Nhân viên 1 (nền, Tra cứu), Kinh doanh 4, Hợp đồng 11, Tiện ích 15, Tài chính 7, Phản hồi 2, Nhân sự 12, Chấm công 10, Lương & bảo hiểm 10. Ẩn 15 bảng: `S_*` và `M_DataLock`.
- Vai trò User (`user_chuyen_doi`) được cấp mọi gói ở mức Đầy đủ: đọc đúng các bảng như trước, trừ 2 bảng hệ thống đang bật nay bị ẩn (41 → 39). Không chỉ tiêu hay mẫu nghiệp vụ nào dùng bảng bị ẩn.
- Widget `emb_msepesjixxr73f` dùng vai trò mới `widget_ipms` (cùng 39 bảng). Đã bỏ quyền widget kiểu cũ trên IPMS.

**Chạy thử thật trên “Google Gemini - Payment”:** 2/2 câu đạt (`bill-ka-feb`, `feedback-in-progress`). Lần chạy đầu phát hiện lỗi: bước tải lại quyền trên PostgreSQL không nạp danh sách AI Provider, nên mọi câu hỏi dữ liệu bị dừng. Đã sửa (`governance/context.js`), cùng hai chỗ nạp thiếu dữ liệu (`/api/library` thiếu thư mục theo dõi, `/api/dictionary` thiếu quan hệ bảng).

**Còn lại:** 90 quan hệ bảng ở trạng thái “gợi ý” chưa xác minh; giai đoạn 4.

**Vai trò mẫu (28/10):** đã tạo Quản lý, Kế toán, Kinh doanh, Vận hành KCN, Nhân sự, Lương theo mục 3.5 (chưa gán tài khoản nào). Kiểm tra độ phủ: không có bảng mồ côi; các chỗ “chỉ hiện mã” đều do 31 quan hệ đã xác minh chưa khai báo cột hiển thị (ví dụ `BS_*`→`M_Customer`, `T_ContractDetail`→`T_Contract`), không do phân quyền. 15 bảng chưa có quan hệ nối với bảng khác trong cùng gói.

**Cột hiển thị (28/10):** đã khai báo cột hiển thị cho 31 quan hệ còn thiếu (ví dụ `M_Customer.CustomerName`, `T_Contract.ContractNo`, `M_IndustrialPark.IndustrialParkName`); quan hệ vẫn giữ trạng thái đã xác minh. Sao lưu: `data/backup/relationship-display-2026-10-27T20-26-34-935Z.json`. Kiểm tra độ phủ chỉ còn `T_CustomerDebt`→`M_DataLock`, đúng thiết kế vì `M_DataLock` là bảng ẩn. `eval:schema` trước và sau đều 32/32.

**Bật bảng cho ai (28/10):**
- Mọi 94 bảng IPMS đã thuộc gói (kể cả bảng đang tắt): bật bảng nào thì bảng đó mở ngay cho các vai trò có gói tương ứng. Trang Lược đồ báo ngay “bảng thuộc gói X, mở cho …”, hoặc cảnh báo khi bảng đang ẩn, chưa thuộc gói, hay gói chưa cấp cho vai trò nào.
- Bảng mới từ đồng bộ lược đồ chưa thuộc gói thì chỉ admin hỏi được; thẻ Nguồn dữ liệu cảnh báo “N bảng chưa thuộc gói”.
- Bộ nhớ đệm phạm vi nhận biết bật/tắt bảng, ẩn/hiện cột và sửa quan hệ ngay (trước đây ở chế độ JSON có thể chậm).
- Gỡ gói Nhân sự, Chấm công, Lương & bảo hiểm khỏi vai trò User và Widget IPMS (32 bảng này đều đang tắt nên không ai mất quyền hiện có). Khi bật, chỉ vai trò Nhân sự và Lương đọc được. Sao lưu: `data/backup/function-groups-2026-10-27T20-30-54-681Z.json`.
- Còn lưu ý: User và Widget IPMS vẫn đọc đầy đủ `M_Employee` (gồm số giấy tờ, ngân hàng, liên lạc) như trước. Nên hạ xuống Tra cứu khi đã rõ ai cần.

**Widget (28/10):** widget `ember-chat-tpsoft` (chế độ Page chat: người dùng đăng nhập bằng tài khoản của họ) đã chuyển về vai trò Khách widget; đã xóa vai trò và nhóm “Widget IPMS (chuyển đổi)”. Khách không đăng nhập qua widget không đọc được nguồn SQL hay tài liệu nào. Thêm chức năng xóa vai trò tùy chỉnh (chặn khi còn tài khoản hoặc widget dùng). Sao lưu: `data/backup/widget-role-2026-10-27T20-36-07-202Z`.
