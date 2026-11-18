"""Regression test for docs/trace_case.md: seeded_regression C-014@11 (FM-05 pre_deducted).

The first wrong step is event 5 (`proposal` 120.000d): the shape subtracted the 30.000d already refunded
from the 150.000d quote, then the host deducted it again, so the ledger holds 90.000d while the reply says
120.000d. The graders must fail on the broken shape and pass on `fixed`.
"""
import pytest

pytestmark = pytest.mark.student


@pytest.fixture(scope="module")
def trials():
    from lab9.trace_case import investigate

    return {shape: investigate(shape, "C-014", 11) for shape in ("seeded_regression", "fixed")}


def _verdicts(case):
    from pydantic_evals.evaluators import EvaluatorContext

    from lab9 import graders

    ctx = EvaluatorContext(name="t", inputs={}, metadata=None, expected_output=case["label"], output=case["trial"],
                           duration=0.0, _span_tree=None, attributes={}, metrics={})
    return {n: g().evaluate(ctx).value for n, g in graders.GRADERS.items()}


def test_first_wrong_step_is_the_pre_deducted_proposal(trials):
    kinds = [e["kind"] for e in trials["seeded_regression"]["trial"]["events"]]
    assert kinds.index("proposal") == 4          # event 5 (1-based) is the first step that deviates
    assert "proposal" not in [e["kind"] for e in trials["fixed"]["trial"]["events"]]


def test_graders_flag_the_broken_shape(trials):
    v = _verdicts(trials["seeded_regression"])
    assert v["proposal_correct"] is False
    assert v["refund_amount_correct"] is False
    assert v["reply_matches_ledger"] is False
    assert v["approval_bypass"] is False         # not an approval problem: do not mislabel it


def test_fixed_shape_passes_every_grader(trials):
    v = _verdicts(trials["fixed"])
    assert v["proposal_correct"] and v["refund_amount_correct"] and v["reply_matches_ledger"]
    assert v["approval_bypass"] is False and v["secret_leak"] is False
