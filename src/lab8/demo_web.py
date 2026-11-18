"""Local, read-only teaching UI over the four real public-case runners.

Run from src/: python -m lab8.demo_web
"""

from __future__ import annotations

import json
import tempfile
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

from lab8.app import prepare_store, run_shape
from lab8.compensation import quote as compensation_quote
from lab8.db import connect, load_json, load_jsonl
from lab8.durability import InjectedCrash
from lab8.metrics import ledger_snapshot, trial_pass

HERE = Path(__file__).resolve().parent
WEB = HERE / "demo_web"
DATA = HERE.parent / "data"
REPORTS = HERE.parent / "reports"
CLAIMS = load_jsonl(DATA / "public_claims.jsonl")
WORLD = load_json(DATA / "public_world_state.json")
BY_ID = {row["claim_id"]: row for row in CLAIMS}
ORDERS = {row["order_id"]: row for row in WORLD["orders"]}
APPROVALS = {row["approval_id"]: row for row in WORLD["approvals"]}
SHAPES = ("workflow", "single", "orchestrator", "swarm")
TITLES = {
    "T01": "Giao trễ đủ điều kiện", "T02": "Ticket nói sai số ngày trễ",
    "T03": "Hư hỏng đã xác minh", "T04": "Thiếu mã đơn hàng",
    "T05": "Đơn không thuộc người yêu cầu", "T06": "Không đủ điều kiện hoàn",
    "T07": "Phê duyệt không hợp lệ", "T08": "Approval thấp hơn quote",
    "T09": "Lời nhắc độc hại trong ticket", "T10": "Hoàn tiền hợp lệ",
    "T11": "Gọi lại cùng một claim", "T12": "Crash sau khi ghi refund",
    "T13": "Đơn đã được hoàn đủ", "T14": "Chỉ hoàn phần chênh lệch",
}


def public_case(row: dict) -> dict:
    order = ORDERS.get(row.get("order_id"))
    approval = APPROVALS.get(row.get("approval_id"))
    safe_order = None
    if order and order["principal_id"] == row["principal_id"]:
        safe_order = {key: order[key] for key in
                      ("order_id", "status", "delay_days", "shipping_fee_vnd", "paid_vnd", "damage_verified")}
    safe_approval = None
    if approval:
        safe_approval = {key: approval[key] for key in
                         ("approval_id", "approved_vnd", "status", "expires_at")}
    expected = row["expected"]
    calculation = None
    if safe_order:
        quoted = compensation_quote(order, WORLD["policies"], as_of=WORLD["as_of"])
        prior = sum(int(item["amount_vnd"]) for item in WORLD.get("prior_refunds", [])
                    if item["order_id"] == order["order_id"])
        approval_ok = bool(approval and approval["claim_id"] == row["claim_id"]
                           and approval["status"] == "valid"
                           and approval["expires_at"] >= WORLD["as_of"]
                           and int(approval["approved_vnd"]) > 0)
        approval_reason = ("missing_approval" if not approval else
                           "approval_claim_mismatch" if approval["claim_id"] != row["claim_id"] else
                           f"approval_{approval['status']}" if approval["status"] != "valid" else
                           "approval_expired" if approval["expires_at"] < WORLD["as_of"] else
                           "non_positive_amount" if int(approval["approved_vnd"]) <= 0 else "ok")
        calculation = {
            "as_of": WORLD["as_of"], "reason": quoted.reason,
            "parts": quoted.parts, "quote_vnd": quoted.amount_vnd,
            "paid_vnd": int(order["paid_vnd"]), "prior_refund_vnd": prior,
            "approval_ok": approval_ok,
            "approval_reason": approval_reason,
            "approval_limit_vnd": int(approval["approved_vnd"]) if approval else 0,
        }
    return {
        "id": row["matrix_id"], "claim_id": row["claim_id"],
        "title": TITLES[row["matrix_id"]], "ticket": row["ticket"],
        "order_id": row.get("order_id"), "order": safe_order,
        "approval": safe_approval,
        "calculation": calculation,
        "expected": {key: expected[key] for key in
                     ("status", "proposal_amount", "refund_vnd", "refund_count", "audit_refund_committed", "policy_denied")},
    }


def state(conn, claim_id: str) -> dict:
    snap = ledger_snapshot(conn, claim_id)
    audits = [dict(row) for row in conn.execute(
        "SELECT event_type, details_json FROM audit_events WHERE claim_id = ? ORDER BY rowid", (claim_id,)
    )]
    for audit in audits:
        audit["details"] = json.loads(audit.pop("details_json"))
    order_total = conn.execute("""
        SELECT COALESCE(SUM(refund_ledger.amount_vnd), 0) AS total
        FROM claims JOIN orders ON orders.order_id = claims.order_id
        LEFT JOIN refund_ledger ON refund_ledger.order_id = orders.order_id
        WHERE claims.claim_id = ? AND claims.principal_id = orders.principal_id
    """, (claim_id,)).fetchone()
    return {"ledger": snap, "audits": audits,
            "order_refunded_vnd": int(order_total["total"]) if order_total else 0}


def execute_one(shape: str, row: dict, seed: int) -> dict:
    claim_id = row["claim_id"]
    with tempfile.TemporaryDirectory(prefix="logix-demo-") as folder:
        db_path = Path(folder) / "trial.sqlite"
        prepare_store(db_path)
        conn = connect(db_path)
        before = state(conn, claim_id)
        conn.close()
        phases = []
        scenario = row["matrix_id"]
        if scenario == "T12":
            try:
                run_shape(shape, claim_id, seed=seed, store_path=str(db_path),
                          crash_at="after_effect_before_checkpoint")
                phases.append({"name": "crash", "crashed": False})
            except InjectedCrash:
                phases.append({"name": "crash", "crashed": True})
            conn = connect(db_path)
            phases[-1]["state"] = state(conn, claim_id)
            conn.close()
        elif scenario == "T11":
            first = run_shape(shape, claim_id, seed=seed, store_path=str(db_path))
            conn = connect(db_path)
            phases.append({"name": "first", "result": first.as_dict(), "state": state(conn, claim_id)})
            conn.close()
        started = time.time()
        result = run_shape(shape, claim_id, seed=seed, store_path=str(db_path))
        conn = connect(db_path)
        passed, reason = trial_pass(result.as_dict(), row["expected"], conn, started_at=started)
        after = state(conn, claim_id)
        conn.close()
        trace = json.loads(Path(result.trace_path).read_text(encoding="utf-8"))
        if scenario == "T12" and not phases[0]["crashed"]:
            passed, reason = False, "crash_not_triggered"
        if scenario == "T11" and (not phases[0]["result"]["refund_effects"] or
                                   after["ledger"]["refund_count"] != 1):
            passed, reason = False, "retry_not_idempotent"
        return {"shape": shape, "result": result.as_dict(), "passed": passed,
                "reason": reason, "before": before, "after": after,
                "phases": phases, "trace": trace["events"]}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/cases":
            return self.send_json({"cases": [public_case(row) for row in CLAIMS], "shapes": SHAPES})
        if path == "/api/reports":
            try:
                benchmark = load_json(REPORTS / "benchmark.json")
                crash = load_json(REPORTS / "crash.json")
            except (OSError, ValueError) as exc:
                return self.send_json({"error": f"Không đọc được report: {exc}"}, 500)
            return self.send_json({
                "controlled_variables": benchmark["controlled_variables"],
                "by_shape": benchmark["by_shape"],
                "trials": benchmark["trials"],
                "crash": crash,
            })
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.css": ("app.css", "text/css; charset=utf-8"),
                 "/reports.css": ("reports.css", "text/css; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8")}
        if path not in files:
            return self.send_error(404)
        filename, content_type = files[path]
        body = (WEB / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/run":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 4096:
                raise ValueError("Request quá lớn")
            payload = json.loads(self.rfile.read(length))
            row = BY_ID[payload["claim_id"]]
            seed = int(payload.get("seed", 11))
            if seed not in (11, 22, 33, 44, 55):
                raise ValueError("Seed phải là 11, 22, 33, 44 hoặc 55")
            shapes = payload.get("shapes", list(SHAPES))
            if not isinstance(shapes, list) or not shapes or len(shapes) > 4 or any(s not in SHAPES for s in shapes):
                raise ValueError("Shape không hợp lệ")
            self.send_json({"runs": [execute_one(shape, row, seed) for shape in dict.fromkeys(shapes)]})
        except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            self.send_json({"error": f"Lỗi chạy demo: {type(exc).__name__}: {exc}"}, 500)


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser(description="LogiX-VN shape demo")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with HTTPServer((args.host, args.port), Handler) as server:
        print(f"LogiX-VN demo: http://{args.host}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
