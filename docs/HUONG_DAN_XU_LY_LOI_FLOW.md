# Hướng dẫn xử lý lỗi Google Flow cho người mới

Tài liệu này dành cho người không biết kỹ thuật.

Một vài từ trong tài liệu:

- **Tab Flow**: trang Google Flow đang mở trong Chrome.
- **Side Panel**: bảng ứng dụng AI Flow Automation nằm bên cạnh Chrome.
- **Reload tab Flow**: mở tab Flow và nhấn `Ctrl + R`.
- **Reload extension**: mở `chrome://extensions`, tìm AI Flow Automation, bấm biểu tượng tải lại, sau đó reload tab Flow.

## Nhớ 3 điều này trước tiên

1. Thấy **Flow healthy**: dùng ứng dụng bình thường.
2. Thấy lỗi: **dừng bấm Generate**, mở tab Flow và kiểm tra trước.
3. Thấy **Flow job status uncertain**: tuyệt đối không chạy lại ngay vì tác vụ cũ có thể vẫn đang tạo ảnh hoặc video.

## Lỗi xuất hiện ở đâu?

Trong màn hình **Google Flow**, nhìn các vị trí sau:

1. **Flow Recovery**: góc phải hiển thị tình trạng hiện tại của Flow.
2. Dòng nhỏ dưới **Flow Recovery**: cho biết lý do lỗi.
3. Khung màu vàng phía trên nút Generate: xuất hiện khi ứng dụng đang chặn tác vụ mới để tránh tạo trùng.
4. **Runtime Verification**: chỉ dùng để kiểm tra chi tiết hoặc xuất báo cáo khi cần hỗ trợ.

## Cách xử lý nhanh nhất

Làm lần lượt, không bấm nhiều nút cùng lúc:

1. Bấm **Open Flow tab**.
2. Kiểm tra Flow đã đăng nhập và đang mở đúng trang dự án có ô nhập prompt hay chưa.
3. Nếu Flow vẫn đang tạo ảnh/video, hãy chờ nó xong.
4. Quay lại ứng dụng và bấm **Run health probe**.
5. Chỉ tiếp tục Generate khi thấy **Flow healthy**.

Nếu vẫn không khỏe, xem đúng lỗi trong bảng dưới đây.

## Nhìn lỗi và làm gì?

| Dòng bạn nhìn thấy | Nghĩa đơn giản | Bạn nên làm |
| --- | --- | --- |
| **Flow healthy** | Flow hoạt động bình thường. | Có thể Generate. |
| **Flow transient failure — health check required** | Lỗi tạm thời hoặc ứng dụng chưa kết nối được với Flow. | Mở tab Flow, chờ trang tải xong rồi bấm **Run health probe**. |
| **Flow session needs recovery** | Phiên đăng nhập Flow có thể đã hết hạn. | Bấm **Open Flow tab**, đăng nhập lại nếu cần, sau đó bấm **Attempt session recovery**. |
| **Refreshing Flow session** | Ứng dụng đang thử khôi phục phiên Flow. | Chờ hoàn tất, không bấm Generate. |
| **Flow rate limited — retry after...** | Google đang giới hạn vì có quá nhiều yêu cầu. | Chờ đến giờ hiển thị. Không Generate liên tục và không manual reset để vượt thời gian chờ. |
| **Flow cooldown awaiting health probe** | Đã hết hoặc gần hết thời gian chờ, nhưng Flow chưa được kiểm tra lại. | Bấm **Run health probe** một lần. |
| **Flow blocked — user action required** | Ứng dụng cần bạn kiểm tra Flow bằng mắt. | Mở tab Flow, xử lý thông báo của Google, rồi bấm **Run health probe**. |
| **Flow job status uncertain** | Ứng dụng không chắc tác vụ trước đã dừng hay vẫn đang chạy. | Mở Flow và kiểm tra. Nếu còn đang chạy thì chờ. Không Generate lại. |
| **Flow recovery status unavailable** | Ứng dụng chưa đọc được trạng thái Flow. | Đóng rồi mở lại Side Panel. Nếu vẫn lỗi, mở Flow và chạy **Runtime Verification** theo hướng dẫn bên dưới. |
| **Flow recovery persistence unavailable — admission blocked** | Trạng thái an toàn không lưu được nên ứng dụng chủ động chặn Generate. | Reload extension, mở lại Side Panel rồi bấm **Run health probe**. Nếu vẫn lỗi, xuất báo cáo. |

Bạn cũng có thể thấy các mã lỗi tiếng Anh trong khung vàng hoặc báo cáo:

| Mã lỗi | Nghĩa đơn giản | Cách xử lý |
| --- | --- | --- |
| `flow_busy` | Flow đang có tác vụ khác. | Chờ tác vụ hiện tại xong. |
| `session_expired` | Đã hết phiên đăng nhập. | Mở Flow, đăng nhập lại, dùng **Attempt session recovery** nếu nút sáng. |
| `rate_limited` | Google giới hạn tần suất. | Chờ đúng thời gian được báo; không gửi thêm yêu cầu. |
| `unusual_activity` | Google phát hiện hoạt động bất thường. | Mở Flow và làm theo thông báo của Google. Không cố chạy lại liên tục. |
| `generation_failed` | Flow không tạo được nội dung. | Kiểm tra thông báo trên Flow, chờ một lúc, chạy health probe rồi mới thử lại một lần. |
| `generation_timeout` | Ứng dụng chờ quá lâu và chưa biết kết quả cuối. | Kiểm tra tab Flow. Không chạy lại cho đến khi chắc chắn tác vụ cũ đã kết thúc. |
| `submit_uncertain` | Không chắc lệnh Generate đã được Flow nhận hay chưa. | Kiểm tra tab Flow. Không bấm Generate lại ngay. |
| `composer_missing` | Không tìm thấy ô nhập prompt của Flow. | Mở đúng dự án Flow có ô prompt, chờ tải xong rồi chạy health probe. |
| `bridge_unavailable` | Extension chưa kết nối được với trang Flow. | Reload tab Flow. Nếu vẫn lỗi, reload extension rồi mở lại Flow. |
| `download_failed` | Nội dung có thể đã tạo xong nhưng tải xuống thất bại. | Kiểm tra kết quả trên Flow và tải thủ công. Không Generate lại chỉ để tải lại. |
| `cancelled` | Tác vụ trong ứng dụng đã bị hủy. | Kiểm tra Flow vì tác vụ đã gửi sang Flow có thể vẫn tiếp tục chạy. |
| `unknown` | Chưa xác định được lỗi. | Không chạy liên tục. Xuất **Diagnostic Report** để gửi người hỗ trợ. |

## Các nút trong Flow Recovery dùng khi nào?

### Run health probe

Dùng sau khi bạn đã mở và kiểm tra tab Flow. Nút này chỉ kiểm tra tình trạng, không tạo ảnh hoặc video.

### Attempt session recovery

Chỉ dùng khi thấy **Flow session needs recovery** hoặc mã `session_expired`. Nút bị mờ trong các trường hợp khác là bình thường.

### Open Flow tab

Dùng để mở Flow và tự kiểm tra xem:

- Đã đăng nhập chưa.
- Có đang ở đúng dự án không.
- Có thông báo chặn của Google không.
- Có ảnh/video nào vẫn đang được tạo không.

### Acknowledge / manual reset

Chỉ dùng sau khi bạn đã nhìn tab Flow và chắc chắn tác vụ cũ không còn chạy.

**Quan trọng:** nút này chỉ xóa trạng thái chặn trong extension. Nó không hủy tác vụ đang chạy trên Google Flow.

## Runtime Verification dùng khi nào?

Bình thường cứ để **Runtime Diagnostics: OFF**. Chỉ bật khi lỗi không hết hoặc cần gửi báo cáo cho người hỗ trợ.

Các kiểm tra này không tạo ảnh hoặc video.

| Nút | Dùng để làm gì? |
| --- | --- |
| **Run Handshake** | Kiểm tra extension có kết nối đủ với Flow hay không. |
| **Run Health Probe** | Kiểm tra tab, đăng nhập, ô prompt, cảnh báo và tác vụ đang chạy. |
| **Show Admission State** | Kiểm tra ứng dụng có đang cho phép một tác vụ mới chạy hay không. |
| **Admission Dry-Run** | Thử kiểm tra khả năng chạy nhưng không gửi prompt và không Generate thật. |
| **Export Diagnostic Report** | Tải file báo cáo `.json` để gửi người hỗ trợ. |
| **Reset Diagnostic Logs** | Chỉ xóa nhật ký kiểm tra; không sửa lỗi và không bỏ chặn Generate. |

Khi kết quả hiện ra, người mới chỉ cần nhìn các dòng sau:

| Kết quả | Có nghĩa là gì? |
| --- | --- |
| `success: true` hoặc `MATCH` | Phần đang kiểm tra đã kết nối đúng. |
| `success: false`, `fail`, `MISSING` hoặc `MISMATCH` | Có lỗi; hãy xuất báo cáo. |
| Admission `state: idle` | Không có tác vụ nào đang giữ lượt. |
| Admission `in_flight`, `checking` hoặc `admitted` | Có tác vụ đang bắt đầu hoặc đang chạy; hãy chờ. |
| Admission `submit_uncertain` hoặc `blocked` | Không Generate lại; kiểm tra tab Flow hoặc nhờ hỗ trợ. |
| Dry-Run `wouldAdmit: true` | Nếu bấm Generate thì kiểm tra an toàn dự kiến sẽ cho chạy. |
| Dry-Run `wouldAdmit: false` | Chưa nên Generate; xem `statusReason` hoặc xuất báo cáo. |

## Cách lấy báo cáo để nhờ hỗ trợ

1. Mở đúng tab dự án Google Flow đang bị lỗi.
2. Bật **Runtime Diagnostics: ON**.
3. Bấm **Run Handshake**.
4. Bấm **Run Health Probe**.
5. Bấm **Show Admission State**.
6. Bấm **Export Diagnostic Report**.
7. Gửi file `.json` vừa tải cho người hỗ trợ và nói bạn gặp lỗi vào khoảng mấy giờ.

Đừng bấm **Reset Diagnostic Logs** trước khi xuất báo cáo, vì dữ liệu cần kiểm tra sẽ bị xóa.

## Khi nào mới được manual reset?

Chỉ manual reset khi cả ba điều sau đều đúng:

- Bạn đã mở tab Flow để kiểm tra.
- Không còn ảnh/video nào đang xử lý.
- Bạn hiểu rằng reset extension không hủy công việc trên Flow.

Nếu không chắc, đừng reset và đừng Generate lại. Hãy xuất Diagnostic Report để nhờ kiểm tra.

## Tài liệu kỹ thuật

Người dùng thông thường không cần đọc phần này:

- [Quy trình kiểm tra runtime đầy đủ](./FLOW_RUNTIME_VERIFICATION.md)
- [Cơ chế Flow Recovery Controller](./FLOW_RECOVERY_CONTROLLER.md)
