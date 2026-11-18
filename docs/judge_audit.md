# Judge audit

Chạy: `python -m lab9.judge --csv <file> --audit 8` (replay, không cần key).

| Tiêu chí | n | κ | Precision | Recall | Đạt FLOORS (κ≥0.6, P≥0.8, R≥0.7)? | Quyết định |
|---|---|---|---|---|---|---|
| tone_ok | 100 | 0.757 | 0.857 | 0.800 | **Đạt** cả 3 (tp 24, fp 4, fn 6, tn 66; tỉ lệ FAIL quan sát 0.28 → hiệu chỉnh Rogan-Gladen 0.30) | **Dùng** (chỉ cho giọng điệu, không phải gate tiền/approval) |
| helpful | 100 | 0.375 | 1.000 | **0.300** | **Không đạt** κ và R (tp 9, fp 0, fn 21, tn 70; quan sát 0.09 → hiệu chỉnh 0.30) | **Loại** |

## Vì sao `helpful` không được làm gate
- Precision 1.0 đánh lừa: judge hiếm khi báo nhầm nhưng **bỏ sót 21/30 lỗi thật** (recall 0.3). Gate dùng nó sẽ cho qua 70% bản lỗi.
- 18/21 lỗi bị bỏ sót là "sai tiền" (reply nói số khác ledger), 3/21 là "sai xưng hô". Judge chỉ đọc reply, **không thấy ledger**, nên câu văn lịch sự, dài, nhiều lời xin lỗi (HL-016, HL-035) vẫn được PASS dù số tiền sai: thiên kiến độ dài/độ trôi chảy.
- Rogan-Gladen sửa được tỉ lệ lỗi tổng (0.09 → 0.30) nhưng không sửa được quyết định trên từng bản PR; với recall 0.3 khoảng tin cậy quá rộng.
- Kết luận: "sai tiền" phải chấm bằng code (`ReplyMatchesLedger`, `RefundAmountCorrect`), không bằng judge.

## 8 case audit thủ công (tone_ok; 10 bất đồng tổng cộng, in 8 đầu)
| # | Case | Judge | Người | Ai đúng? | Ghi chú / sửa rubric |
|---|---|---|---|---|---|
| 1 | H-008 "Em đã hoàn tiền cho anh rồi nha, anh check giúp em." | PASS | FAIL | Người | Xưng "em" + "nha" quá suồng sã; judge coi là thân thiện. **Sửa rubric:** xưng hô chuẩn "Dạ … LogiX … anh/chị"; không dùng "nha", "em" với khách. |
| 2 | H-017 "Dạ, bạn ơi LogiX đã hoàn … rồi nha." | PASS | FAIL | Người | Xưng "bạn" với khách lớn tuổi. **Sửa:** liệt kê đại từ cấm ("bạn", "em") kèm ví dụ FAIL. |
| 3 | H-029 "Dạ, vui lòng chờ. … không cần nhắn thêm." | PASS | FAIL | Người | Giọng ra lệnh bị che bởi "Dạ, vui lòng". **Sửa:** mệnh lệnh trực tiếp tới khách là FAIL dù mở đầu lịch sự. |
| 4 | H-042 "Dạ, đơn O-808 đã hoàn 120.000đ. Tiền về trong 3–5 ngày ạ." | FAIL | PASS | Người | Ngắn nhưng đủ ý; judge phạt vì "thiếu xin lỗi". **Sửa:** không bắt buộc xin lỗi khi yêu cầu đã được đáp ứng. |
| 5 | H-051 "Dạ, LogiX đã refund 90.000đ …" | FAIL | PASS | Người | "refund" được CS LogiX cho phép. **Sửa:** thêm danh sách thuật ngữ nội bộ được phép vào rubric. |
| 6 | H-063 "… đã hoàn 20.000đ và sẽ hoàn thêm cho anh/chị ạ." | PASS | FAIL | Người | Hứa ngoài kết quả hệ thống: lỗi cam kết, không chỉ giọng điệu ⇒ **chuyển sang grader code** (reply không được hứa khoản chưa có trong ledger). |
| 7 | H-070 "… ạ 😂😂" | PASS | FAIL | Người | Emoji đùa trong ngữ cảnh khiếu nại. **Sửa:** emoji cười/đùa trong khiếu nại = FAIL. |
| 8 | H-081 "Dạ, đơn O-107 chưa đủ điều kiện hoàn …" | FAIL | PASS | **Judge** | Nhãn người sai (đọc nhầm ticket). **Sửa nhãn người**, không sửa judge; cần người thứ hai duyệt lại. |

## Kết luận
- `tone_ok` dùng được; lỗi còn lại dồn vào xưng hô / giọng ra lệnh / emoji: 6/8 case audit sửa được bằng rubric cụ thể hơn, 1 nên chuyển sang code (H-063), 1 là nhãn người sai (H-081).
- `helpful` bị loại; phần "sai tiền" chuyển cho `ReplyMatchesLedger` (FM-08).
- Rủi ro còn lại: judge chỉ kiểm trên dữ liệu replay đã công khai, 1 người gán nhãn; cần tập held-out mới và ≥2 người gán nhãn để đo đồng thuận giữa người.
