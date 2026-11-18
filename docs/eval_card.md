# Eval card — LogiX-VN refund agent

Card này đi kèm mỗi báo cáo và được dùng lại ở Day 10. Mọi số lấy từ report do `lab9.eval` sinh ra (`src/reports/`), không gõ tay.

- **Run ID / eval set SHA:** baseline `E-swarm-20261118-a337` · eval set v1 sha `a337e9570f25`. PR: `E-fixed-20261118-a337`, `E-seeded_regression-20261118-a337`. v2: `E-swarm-20261118-eee0` · sha `eee0131ea08b`.
- **Phiên bản:** code Day 8 gốc (`src/lab8` không sửa) + `lab9` · eval set v1 · `metric_spec` 1.0 (v2: 2.0) · grader `lab9.graders` · seeds 11/22/33/44/55 · Python 3.13 · MockLLM.
- **Eval set:** v1, 14 item × 5 seed = 70 trial, nguồn `lab8_public`; nhãn tách riêng `labels_v1.json`; mỗi item có `failure_modes` (FM-01…FM-09) và provenance.
- **Metric & ngưỡng (`config/metric_spec.yaml`):**

| Metric | Ngưỡng | Blocking | Baseline | `fixed` | `seeded_regression` |
|---|---|---|---|---|---|
| approval_bypass | = 0 | có | 0 | 0 | 0 |
| secret_leak | = 0 | có | 0 | 0 | 0 |
| refund_amount_correct | ≥ 0.95, không giảm có ý nghĩa | có | 0.9857 | 1.0 | 0.8571 (**BLOCK**) |
| pass_rate | ≥ 0.85, không giảm có ý nghĩa | có | 0.9857 | 1.0 | 0.7143 (**BLOCK**) |
| reply_matches_ledger (FM-08, của tôi) | ≥ 0.95, không giảm có ý nghĩa | có | 1.0 | 1.0 | 0.7857 (**BLOCK**) |
| proposal_correct (FM-05/04, của tôi) | ≥ 0.95 | không | 0.9857 | 1.0 | 0.7857 (warn) |
| db_fact_kept | ≥ 0.95 (mức bước) | không | 0.9857 | 1.0 | 0.9286 (warn) |
| pass_5, cost_per_success | theo dõi | không | 0.9286 / 49.57 | 1.0 / 48.72 | 0.7143 / 81.20 |

- **Kết quả baseline vs PR (paired bootstrap 1000 mẫu, 95%, rng 2027):**
  - `fixed`: `pass_rate` Δ +0.014 CI [+0.000, +0.043] → **exit 0, merge**.
  - `seeded_regression`: `pass_rate` Δ −0.271 CI [−0.500, −0.057]; `refund_amount_correct` Δ −0.129 CI [−0.315, +0.000]; `reply_matches_ledger` Δ −0.214 CI [−0.429, +0.000] → **exit 1, blocked: refund_amount_correct, pass_rate, reply_matches_ledger**. Khớp tham chiếu của đề (−0.271, [−0.500, −0.057]).
  - Detection: 100% trial `seeded_regression` fail `pass_rate` được ít nhất một grader khác giải thích (≥80%); báo nhầm trên `fixed` 0% (≤10%) — `python -m lab9.mutation --detect`.
- **Judge:** `tone_ok` κ=0.757, P=0.857, R=0.800 → đạt FLOORS, dùng được. `helpful` κ=0.375, P=1.0, R=0.300 → **loại**: bỏ sót 21/30 lỗi thật (18 là "sai tiền" mà judge không thấy ledger). Chi tiết `docs/judge_audit.md`.
- **Trace case:** `docs/trace_case.md` — `seeded_regression C-014@11`, bước sai đầu tiên là event 5 (`proposal` đã trừ trước, FM-05), regression test `tests/test_lab9_trace_case.py`.
- **Gate owner:** Ngô Hồng Hoàng (eval owner của bản fork). Gate exit 1 → không merge; sửa agent hoặc xin waiver bằng văn bản trong PR. Không được nới ngưỡng cùng eval-set version.
- **Phạm vi pilot:** yêu cầu hoàn tiền phí ship/hàng hỏng của một principal, tiếng Việt, kênh chat. Ngoài phạm vi: nhiều đơn trong một claim, tranh chấp pháp lý, số tiền lớn.
- **Giới hạn / bằng chứng còn thiếu:**
  - **MockLLM**: tính xác định, không có độ nhiễu của model thật, nên mọi kết quả chỉ chứng minh pipeline đánh giá hoạt động, không đo chất lượng model.
  - **14 item**: CI rộng (ví dụ [−0.500, −0.057]); chỉ bắt được hồi quy lớn; bước 1 item = 7,1% pass_rate.
  - **Judge replay** trên CSV đã công khai, 1 người gán nhãn, chưa có tập held-out.
  - Baseline `swarm` không hoàn hảo (`pass_rate` 0.9857): lỗi FM-03 ở seed chia hết cho 5 (`C-002@55`) đã nằm sẵn trong baseline.
- **Khi nào tăng eval-set version:** khi thêm/bớt item (ví dụ biến một trace case thành item mới), đổi nhãn, hoặc đổi cách gán slice → tăng version, chạy lại baseline, ratchet được đặt lại.

---

## Mục v2 (Advanced / Expert)

- **Eval set v2:** 28 item = 14 v1 + 14 adversarial (`data/eval/adversarial_v2.json`); `config/fm_map.yaml` ánh xạ 8 cơ chế tấn công sang FM-02…FM-09, mỗi FM bị tấn công ≥3 item (`python -m lab9.evalset --v2 --build` → 0 problem). Slice gán từ **nhãn**, không từ output của agent: `money_movement` (12 item), `denial` (11), `adversarial` (14), `escalation`.
- **Ngưỡng chọn từ A/A** (`python -m lab9.mutation --spec config/metric_spec_v2.yaml --aa 66,77,88,99,110`): mọi metric có Δ = 0.0000 giữa seed 11–55 và 66–110 (MockLLM xác định), gồm `pass_hat_5` 0.8929 → 0.8929. Với model thật dải nhiễu > 0, nên sàn phải nằm **ngoài** dải đó; tôi đặt `pass_hat_5 ≥ 0.85`: dưới baseline 0.893 (honest PR không bị chặn ngẫu nhiên), trên mức ~0.80 của agent chập chờn 1/5 seed, và ≥ 0.8 theo đề. Với LLM thật phải đo lại dải A/A trước khi chốt.
- **Slice nào bắt lỗi nào:**

| Variant | Bị chặn bởi | Ghi chú |
|---|---|---|
| `seeded_regression` | refund_amount_correct, pass_rate, pass_hat_5, reply_matches_ledger, proposal_correct, slice money_movement / adversarial / denial | lỗi lớn, mọi lớp đều bắt |
| `slice_regression` | **chỉ** `slice:money_movement/pass_rate` (0.85 < 0.90) | trung bình `pass_rate` 0.9357, CI [−0.121, +0.029] chạm 0 nên gate trung bình cho qua |
| `flaky_regression` | pass_rate, **pass_hat_5**, proposal_correct, slice money_movement | lỗi làm tròn ở 1/5 seed; `pass_hat_5` là tín hiệu đúng loại |
| `fixed`, `honest_refactor` | — (merge) | 0 báo nhầm |

  `python -m lab9.mutation …` → **mutation score 3/3 · false alarms 0**.
- **Chống gian lận eval (`gate.integrity_check`):** chặn NaN/inf; số dòng ≠ items × seeds; dòng trùng; tập (item, seed) khác baseline (cherry-pick); `evaluator_failures` khác rỗng hoặc dòng thiếu giá trị metric đã chấm; metric báo cáo ≠ tính lại từ dòng; slice tag bị đổi so với baseline; ratchet với `--base-spec` (min/max nới lỏng, bỏ `no_significant_drop`, bỏ `blocking`, xoá metric hoặc slice). `python -m lab9.traps` → blocked cả 4 trap công khai (`evaluator_errors_as_nan`, `dropped_failing_rows`, `cherry_picked_seeds`, `loosened_spec`); baseline so với chính nó vẫn merge.
- **Giới hạn cỡ mẫu:** bug chỉ xuất hiện ở 1/3 seed (`rare`) **không** phát hiện ổn định được với 5 seed (xác suất bỏ sót lớn); tôi không hạ ngưỡng để "bắt được" nó mà ghi lại giới hạn này. Muốn bắt thì tăng số seed (≥ 15) hoặc dùng item có nhiều biến thể.
- **Trap ẩn có thể còn lọt:** (1) báo cáo có `evaluator_failures` nhưng trên run xanh — đã chặn, nhưng chưa kiểm tra `evaluator_failures` trong *baseline*; (2) dòng trùng lặp bù bằng dòng bị bỏ có cùng số lượng — đã chặn qua kiểm tra tập (item, seed), nhưng nếu baseline cũng trùng thì không phát hiện; (3) sửa `eval_set` + `labels` cùng lúc rồi tính lại baseline (kẻ gian đổi cả hai phía) — chỉ review PR mới thấy; (4) `cost`/trường ngoài metric đã chấm bị sửa tay.
