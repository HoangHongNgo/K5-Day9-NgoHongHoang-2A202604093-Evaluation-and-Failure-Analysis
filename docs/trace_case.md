# Trace case: từ trace tới quyết định sai đầu tiên

Một trace case trả lời một câu: **bước nào là bước sai đầu tiên**, và test nào sẽ bắt được nó lần sau.

```bash
cd src
python -m lab9.trace_case --shape seeded_regression --claim C-014 --seed 11
python -m lab9.trace_case --shape fixed --claim C-014 --seed 11   # đối chứng
```

## Case: `seeded_regression C-014@11`

| Trường | Nội dung |
|---|---|
| Trial | `seeded_regression C-014@11`, run `E-seeded_regression-20261118-a337` (`src/reports/eval_seeded_regression.json`) |
| Triệu chứng | lab8 grader: `proposal_mismatch`. `RefundAmountCorrect`, `ReplyMatchesLedger`, `ProposalCorrect` đều fail. Reply nói **120.000đ**, ledger ghi **90.000đ**, nhãn 120.000đ. Reply trôi chảy, ledger mới lộ lỗi. |
| Bước sai đầu tiên | **Event 5** `proposal {"amount_vnd": 120000}`: quote ở event 3 là 150.000đ (clause SHIP-LATE-03 + DMG-04) nhưng agent trừ 30.000đ của `refund_history` (event 4) trước khi gọi host. |
| Vì sao là bước *đầu tiên* | Event 1–3 đúng và trùng với `fixed`: handoff hợp lệ, investigator thấy đơn O-515, quote 150.000đ đúng chính sách. Event 4 (đọc lịch sử hoàn) chỉ là đọc, chưa sai. Event 5 là nơi con số lệch khỏi quote; event 6 (reply) chỉ lặp lại số sai, và host sau đó trừ 30.000đ thêm lần nữa (ledger 90.000đ). |
| Failure mode | **FM-05** pre_deducted (kéo theo **FM-08**: reply ≠ ledger) |
| Đối chứng | `fixed C-014@11` không có event `refund_history` / `proposal`; host tự trừ khoản đã hoàn một lần, ledger 120.000đ = nhãn. |
| Regression test | `tests/test_lab9_trace_case.py` (3 test): event `proposal` ở vị trí 5 chỉ có trên shape lỗi; `ProposalCorrect`, `RefundAmountCorrect`, `ReplyMatchesLedger` fail trên `seeded_regression` và pass trên `fixed`; `ApprovalBypass` = False (không gán nhầm sang lỗi approval). Chạy: `python -m pytest -q -m student -o addopts= -k trace_case`. |
| Chưa chắc chắn | Trace không cho biết **vì sao** agent trừ trước (cố ý "trừ phần đã hoàn" hay hiểu sai chính sách); MockLLM là mã giả lập nên không chứng minh model thật mắc cùng lỗi. Ledger 90.000đ suy ra từ host trừ hai lần, không có event nào ghi trực tiếp việc trừ này. |

## Case phụ (cùng hướng)
`seeded_regression C-002@11` (FM-03): event 3 `model_override {"delay_days": 5}` là bước sai đầu tiên; DB nói 3 ngày (không đủ điều kiện) nhưng ledger có 20.000đ. `swarm` gốc cũng dính lỗi này ở seed chia hết cho 5 (`C-002@55`), đó là lý do `swarm` baseline có `pass_rate` 0.9857 chứ không phải 1.0.
