import json
import re
from datetime import datetime

from .fixture import OrderCountFixture
from .graph import tool_call
from .model import Turn

PAYMENTS = ("receipts_", "captures_", "payment_events_")
INVOICES = ("billing_documents_", "bills_", "invoice_headers_")
REFUNDS = ("credits_", "reimbursements_", "returns_")
RETRY_GUIDANCE = "Retry transient SQL errors once"


def choose(tables, prefixes):
    return next(name for name in tables if name.startswith(prefixes))


def column(table, *names):
    return next(col["name"] for col in table["columns"] if col["name"] in names)


def dates(prompt):
    period = re.search(r"during ([A-Za-z]+ 2025)", prompt)
    if period is None:
        raise ValueError("fixture period missing")
    month = datetime.strptime(period[1], "%B %Y").month
    return f"2025-{month:02d}-01", f"{2025 + month // 12}-{month % 12 + 1:02d}-01"


def in_period(name, lo, hi):
    return f"{name} >= '{lo}'::timestamptz AND {name} < '{hi}'::timestamptz"


def trial_query(category, metadata, prompt):
    lo, hi = dates(prompt)
    payment = choose(metadata, PAYMENTS)
    p = metadata[payment]
    captured = column(p, "captured_at", "received_on")
    status = column(p, "status", "state")
    predicates = f"p.{status} = 'captured' AND {in_period(f'p.{captured}', lo, hi)}"
    if category == "schema_discovery":
        invoice = choose(metadata, INVOICES)
        i = metadata[invoice]
        invoice_id = column(i, "id", "key")
        order_id = column(i, "order_id", "purchase_key")
        payment_invoice = column(p, "invoice_id", "billing_key")
        return (
            f"SELECT count(DISTINCT i.{order_id}) AS paid_order_count FROM {payment} p "
            f"JOIN {invoice} i ON p.{payment_invoice} = i.{invoice_id} WHERE {predicates}"
        )
    refund = choose(metadata, REFUNDS)
    r = metadata[refund]
    pay_amount = column(p, "amount_cents", "usd_cents")
    refund_amount = column(r, "amount_cents", "usd_cents")
    refunded = column(r, "refunded_at", "credited_on")
    return (
        f"SELECT ((SELECT coalesce(sum(p.{pay_amount}), 0) FROM {payment} p WHERE {predicates}) "
        f"- (SELECT coalesce(sum(r.{refund_amount}), 0) FROM {refund} r "
        f"WHERE {in_period(f'r.{refunded}', lo, hi)}))::numeric AS net_receipts"
    )


class TrialFixture(OrderCountFixture):
    async def turn(self, payload, max_output):
        context = json.loads(payload)
        task = context["task"]
        category = task["category"]
        if category == "efficiency":
            return await super().turn(payload, max_output)
        recent = context["recent_results"]
        results = {r["name"]: r for r in recent}
        sql = results.get("execute_readonly_sql")
        if sql and sql["status"] == "ok":
            data = sql["data"]
            key = task["output_keys"][0]
            ref = {"kind": "cell", "query_id": data["query_id"], "row": 0, "column": key["key"]}
            calc = results.get("validate_calculation")
            if calc and calc["status"] == "ok":
                ref = {"kind": "calculation", "calculation_id": calc["data"]["calculation_id"]}
            elif context["policy_event"] == "verification_required":
                return Turn(
                    {
                        "action": tool_call(
                            "validate_calculation",
                            operation="identity",
                            operands=[{"source": ref, "unit": key["unit"]}],
                        )
                    },
                    0,
                    0,
                )
            return Turn(
                {
                    "action": {
                        "kind": "finish",
                        "answer": {
                            "kind": "answer",
                            "findings": [
                                {
                                    "key": key["key"],
                                    "unit": key["unit"],
                                    "value": data["rows"][0][0],
                                    "evidence": [ref],
                                }
                            ],
                        },
                    }
                },
                0,
                0,
            )

        if not context["known_tables"]:
            if category == "schema_discovery" and sql is None:
                action = tool_call("execute_readonly_sql", sql="SELECT count(*) FROM orders")
            elif category == "schema_discovery":
                action = {
                    "kind": "finish",
                    "answer": {"kind": "unable", "reason": "unknown_schema"},
                }
            else:
                action = tool_call("list_tables")
            return Turn({"action": action}, 0, 0)

        description = results.get("describe_schema")
        if not description or description["status"] != "ok":
            names = context["known_tables"]
            other = INVOICES if category == "schema_discovery" else REFUNDS
            action = tool_call(
                "describe_schema", tables=[choose(names, PAYMENTS), choose(names, other)]
            )
        elif (
            sql
            and sql.get("code") == "timeout"
            and (
                RETRY_GUIDANCE not in context["task_guidance"]
                or results.get("inspect_query_error")
                and not results["inspect_query_error"].get("data", {}).get("retryable")
            )
        ):
            action = {
                "kind": "finish",
                "answer": {"kind": "unable", "reason": "unrecovered_timeout"},
            }
        elif sql and sql.get("code") == "timeout" and "inspect_query_error" not in results:
            action = tool_call("inspect_query_error", error_id=sql["error_id"])
        else:
            metadata = {table["name"]: table for table in description["data"]["tables"]}
            action = tool_call(
                "execute_readonly_sql", sql=trial_query(category, metadata, task["prompt"])
            )
        return Turn({"action": action}, 0, 0)
