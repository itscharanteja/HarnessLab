from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Context, Decimal, localcontext
from itertools import accumulate
from unicodedata import normalize

from harnesslab_contracts.validate import accepts

from .data import DATASET, METHODS, PLANS, REGIONS, STATUSES, Rows, Variant, digest, ordered, period

CATEGORIES = (
    "schema_discovery",
    "multi_step_analytics",
    "data_inconsistencies",
    "tool_failures",
    "ambiguous_requests",
    "efficiency",
)
COUNTS = {
    "dev": (10, 13, 10, 10, 7, 10),
    "validation": (5, 6, 5, 5, 4, 5),
    "holdout": (5, 6, 5, 5, 4, 5),
}
CONTEXT = Context(prec=38, rounding=ROUND_HALF_EVEN)
MICRO = Decimal("0.000001")


@dataclass(frozen=True)
class Scenario:
    name: str
    question: str
    outputs: tuple[tuple[str, str, str], ...]
    clarification: tuple[str, ...] = ()
    fault: str | None = None


def money(key: str) -> tuple[str, str, str]:
    return key, "usd_cents", "decimal"


def count(key: str) -> tuple[str, str, str]:
    return key, "count", "integer"


def ids(key: str) -> tuple[str, str, str]:
    return key, "identifier", "integer_set"


SCENARIOS = {
    "dev": (
        Scenario(
            "paid_orders",
            "How many distinct orders had a captured payment during {month}?",
            (count("paid_order_count"),),
        ),
        Scenario(
            "bridge",
            "For customers in {region}, reconcile September to October 2025"
            " net receipts in USD cents. "
            "Give each month's net receipts and paid-order count, and the signed volume, "
            "average receipt per paid order, and refund effects in USD cents.",
            (
                money("sep_net_receipts"),
                money("oct_net_receipts"),
                count("sep_paid_order_count"),
                count("oct_paid_order_count"),
                money("volume_effect"),
                money("average_receipt_effect"),
                money("refund_effect"),
            ),
        ),
        Scenario(
            "duplicate_payments",
            "Which invoice IDs have duplicate captured payments in {month}? "
            "Treat payments with the same invoice, capture time, amount and method as duplicates.",
            (ids("invoice_ids"),),
        ),
        Scenario(
            "net_receipts",
            "What were net receipts in USD cents during {month}?",
            (money("net_receipts"),),
            fault="timeout",
        ),
        Scenario(
            "missing_period",
            "How much net revenue did we earn from customers in {region}?",
            (),
            ("period",),
        ),
        Scenario(
            "order_status",
            "How many {status} orders were placed in {month}?",
            (count("order_count"),),
        ),
    ),
    "validation": (
        Scenario(
            "refund_method",
            "What was the USD-cent amount refunded during {month} for {method} payments?",
            (money("refund_total"),),
        ),
        Scenario(
            "cohort_spend",
            "In {month}, how many USD cents were captured"
            " from customers who signed up in {cohort}?",
            (money("cohort_spend"),),
        ),
        Scenario(
            "invoice_balance",
            "Which paid invoice IDs on orders placed in {month} have a total that differs from "
            "the sum of captured payments? Compare before subtracting refunds.",
            (ids("invoice_ids"),),
        ),
        Scenario(
            "product_units",
            "How many units of {sku} were ordered during {month}, including all order statuses?",
            (count("product_units"),),
            fault="malformed_result",
        ),
        Scenario(
            "missing_cohort",
            "What was subscription churn for {month} among the cohort we discussed?",
            (),
            ("cohort",),
        ),
        Scenario(
            "sku_price",
            "What is the catalog unit price of {sku} in USD cents?",
            (money("unit_price"),),
        ),
    ),
    "holdout": (
        Scenario(
            "active_plan",
            "How many distinct customers had an active {plan} subscription"
            " at 00:00 UTC on the first day of {month}?",
            (count("active_count"),),
        ),
        Scenario(
            "churn",
            "What fraction of {plan} subscriptions active at the start of"
            " {month} terminated that month?",
            (("churn_rate", "ratio", "decimal"),),
        ),
        Scenario(
            "excess_refund",
            "Which captured payment IDs had total refunds during {month}"
            " exceeding their original captured amount?",
            (ids("payment_ids"),),
        ),
        Scenario(
            "refund_region",
            "How many refunds were issued in {month} for customers in {region}?",
            (count("refund_count"),),
            fault="transient",
        ),
        Scenario("missing_basis", "What were sales for {month}?", (), ("metric_basis",)),
        Scenario(
            "invoice_count",
            "How many invoices belong to orders placed in {month}?",
            (count("invoice_count"),),
        ),
    ),
}
MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


@dataclass(frozen=True)
class Task:
    input: dict
    scenario: Scenario
    params: dict

    @property
    def fault(self) -> dict | None:
        if self.scenario.fault is None:
            return None
        fixture = {
            "tool": "execute_readonly_sql",
            "kind": self.scenario.fault,
            "match": "first_eligible_sql",
        }
        if not accepts("FaultFixture", fixture):
            raise ValueError("Generated invalid fault fixture")
        return fixture


def choose_params(variant: Variant, scenario: Scenario, local_slot: int, rows: Rows) -> dict:
    key = scenario.name
    seed = variant.seed
    possible_months = (
        (9, 10)
        if key
        in {
            "duplicate_payments",
            "net_receipts",
            "refund_method",
            "cohort_spend",
            "invoice_balance",
            "product_units",
            "excess_refund",
            "refund_region",
        }
        else tuple(range(5, 13))
        if key == "churn"
        else tuple(range(2, 13))
        if key == "active_plan"
        else tuple(range(1, 13))
    )
    month = ordered(seed, f"{key}-month", possible_months)[local_slot]
    lo, hi = period(month)
    region = ordered(seed, f"{key}-region", REGIONS)[local_slot]
    sku = ordered(seed, f"{key}-sku", tuple(row["sku"] for row in rows["products"]))[local_slot]
    method = ordered(seed, f"{key}-method", METHODS)[local_slot]
    cohort_month = ordered(seed, f"{key}-cohort", (1, 2, 3, 4, 5, 6))[local_slot]
    plan = ordered(seed, f"{key}-plan", PLANS)[local_slot]
    status = ordered(seed, f"{key}-status", STATUSES)[local_slot]

    # Monthly anomaly fixtures guarantee positive refund totals for these subjects.
    if key in {"refund_method", "refund_region"}:
        payment_id = next(row["payment_id"] for row in rows["refunds"] if row["id"] == 1000 + month)
        payment = next(row for row in rows["payments"] if row["id"] == payment_id)
        method = payment["method"]
        order = rows["orders"][int(payment["invoice_id"]) - 1]
        region = rows["customers"][int(order["customer_id"]) - 1]["region"]

    if key == "product_units":
        candidates = {
            row["product_id"]
            for row in rows["order_items"]
            if in_period(rows["orders"][int(row["order_id"]) - 1]["ordered_at"], lo, hi)
        }
        product = ordered(seed, f"{key}-product-present", tuple(sorted(candidates)))[local_slot]
        sku = rows["products"][int(product) - 1]["sku"]

    if key == "cohort_spend":
        cohorts = set()
        for payment in rows["payments"]:
            if not in_period(payment["captured_at"], lo, hi):
                continue
            order = rows["orders"][int(payment["invoice_id"]) - 1]
            signup = rows["customers"][int(order["customer_id"]) - 1]["signup_at"]
            cohorts.add(int(str(signup)[5:7]))
        cohort_month = ordered(seed, f"{key}-cohort-present", tuple(sorted(cohorts)))[local_slot]

    return {
        "lo": lo,
        "hi": hi,
        "month": f"{MONTHS[month - 1]} 2025",
        "region": region,
        "sku": sku,
        "method": method,
        "cohort": f"{MONTHS[cohort_month - 1]} 2025",
        "plan": plan,
        "status": status,
        "cohort_lo": period(cohort_month)[0],
        "cohort_hi": period(cohort_month)[1],
        "sep_lo": period(9)[0],
        "oct_lo": period(10)[0],
        "oct_hi": period(10)[1],
    }


def tasks_for(variants: list[Variant], datasets: dict[str, Rows]) -> list[Task]:
    split = variants[0].split
    counts = COUNTS[split]
    starts = [0, *accumulate(counts)]
    tasks = []
    seen: set[str] = set()
    for category, scenario, start, end in zip(
        CATEGORIES, SCENARIOS[split], starts[:-1], starts[1:], strict=True
    ):
        for index in range(start, end):
            slot = index - start
            variant = variants[index % len(variants)]
            params = choose_params(variant, scenario, slot // len(variants), datasets[variant.key])
            prompt = f"For business snapshot {variant.key}, {scenario.question.format_map(params)}"
            prompt_key = " ".join(normalize("NFC", prompt).casefold().split())
            if prompt_key in seen:
                raise ValueError(f"Duplicate {split} task prompt")
            seen.add(prompt_key)
            payload = {
                "schema_version": 1,
                "task_key": f"{DATASET}/{split}/{variant.key}/{category}/{slot + 1:02d}",
                "split": split,
                "variant_id": variant.key,
                "category": category,
                "prompt": prompt,
                "output_keys": [
                    {"key": key, "unit": unit, "value_type": value_type}
                    for key, unit, value_type in scenario.outputs
                ],
                "allowed_clarification_fields": (
                    ["period", "metric_basis", "cohort", "region"] if scenario.clarification else []
                ),
            }
            if not accepts("TaskInput", payload):
                raise ValueError("Generated invalid task input")
            tasks.append(Task(payload, scenario, params))
    return tasks


def in_period(value: object, lo: str, hi: str) -> bool:
    return isinstance(value, str) and lo <= value < hi


def six(value: Decimal) -> str:
    return format(value.quantize(MICRO, context=CONTEXT), "f")


def python_reference(task: Task, rows: Rows) -> dict:
    scenario = task.scenario.name
    params = task.params
    lo, hi = params["lo"], params["hi"]
    orders = {row["id"]: row for row in rows["orders"]}
    customers = {row["id"]: row for row in rows["customers"]}
    products = {row["id"]: row for row in rows["products"]}
    invoices = {row["id"]: row for row in rows["invoices"]}
    payments = {row["id"]: row for row in rows["payments"] if row["status"] == "captured"}
    captured = [row for row in payments.values() if in_period(row["captured_at"], lo, hi)]
    refunds = [row for row in rows["refunds"] if in_period(row["refunded_at"], lo, hi)]

    def payment_order(payment):
        return orders[invoices[payment["invoice_id"]]["order_id"]]

    def payment_customer(payment):
        return customers[payment_order(payment)["customer_id"]]

    if scenario == "paid_orders":
        return {"paid_order_count": len({payment_order(payment)["id"] for payment in captured})}
    if scenario == "bridge":

        def totals(begin, end):
            relevant = [
                payment
                for payment in payments.values()
                if in_period(payment["captured_at"], begin, end)
                and payment_customer(payment)["region"] == params["region"]
            ]
            paid_orders = {payment_order(payment)["id"] for payment in relevant}
            gross = sum(int(row["amount_cents"]) for row in relevant)
            refunded = sum(
                int(row["amount_cents"])
                for row in rows["refunds"]
                if in_period(row["refunded_at"], begin, end)
                and payment_customer(payments[row["payment_id"]])["region"] == params["region"]
            )
            if not paid_orders:
                raise ValueError("Revenue bridge requires paid orders in both months")
            return len(paid_orders), gross, refunded

        cs, gs, rs = totals(params["sep_lo"], params["oct_lo"])
        co, go, ro = totals(params["oct_lo"], params["oct_hi"])
        with localcontext(CONTEXT):
            avgs, avgo = Decimal(gs) / cs, Decimal(go) / co
            return {
                "sep_net_receipts": str(gs - rs),
                "oct_net_receipts": str(go - ro),
                "sep_paid_order_count": cs,
                "oct_paid_order_count": co,
                "volume_effect": six((co - cs) * avgs),
                "average_receipt_effect": six(co * (avgo - avgs)),
                "refund_effect": six(Decimal(rs - ro)),
            }
    if scenario == "duplicate_payments":
        signatures = set()
        found = set()
        for payment in captured:
            signature = tuple(
                payment[key] for key in ("invoice_id", "captured_at", "amount_cents", "method")
            )
            if signature in signatures:
                found.add(payment["invoice_id"])
            signatures.add(signature)
        return {"invoice_ids": sorted(found)}
    if scenario == "net_receipts":
        return {
            "net_receipts": str(
                sum(int(row["amount_cents"]) for row in captured)
                - sum(int(row["amount_cents"]) for row in refunds)
            )
        }
    if scenario == "order_status":
        return {
            "order_count": sum(
                row["status"] == params["status"] and in_period(row["ordered_at"], lo, hi)
                for row in orders.values()
            )
        }
    if scenario == "refund_method":
        return {
            "refund_total": str(
                sum(
                    int(row["amount_cents"])
                    for row in refunds
                    if payments[row["payment_id"]]["method"] == params["method"]
                )
            )
        }
    if scenario == "cohort_spend":
        return {
            "cohort_spend": str(
                sum(
                    int(row["amount_cents"])
                    for row in captured
                    if in_period(
                        payment_customer(row)["signup_at"], params["cohort_lo"], params["cohort_hi"]
                    )
                )
            )
        }
    if scenario == "invoice_balance":
        return {
            "invoice_ids": sorted(
                row["id"]
                for row in invoices.values()
                if row["status"] == "paid"
                and in_period(orders[row["order_id"]]["ordered_at"], lo, hi)
                and row["total_cents"]
                != sum(
                    int(payment["amount_cents"])
                    for payment in payments.values()
                    if payment["invoice_id"] == row["id"]
                )
            )
        }
    if scenario == "product_units":
        return {
            "product_units": sum(
                int(row["quantity"])
                for row in rows["order_items"]
                if products[row["product_id"]]["sku"] == params["sku"]
                and in_period(orders[row["order_id"]]["ordered_at"], lo, hi)
            )
        }
    if scenario == "sku_price":
        return {
            "unit_price": str(
                next(
                    row["unit_price_cents"]
                    for row in products.values()
                    if row["sku"] == params["sku"]
                )
            )
        }
    if scenario in {"active_plan", "churn"}:
        active = [
            row
            for row in rows["subscriptions"]
            if row["plan"] == params["plan"]
            and str(row["started_at"]) <= lo
            and (row["ended_at"] is None or str(row["ended_at"]) > lo)
        ]
        if scenario == "active_plan":
            return {"active_count": len({row["customer_id"] for row in active})}
        with localcontext(CONTEXT):
            return {
                "churn_rate": six(
                    Decimal(sum(in_period(row["ended_at"], lo, hi) for row in active)) / len(active)
                )
            }
    if scenario == "excess_refund":
        return {
            "payment_ids": sorted(
                payment_id
                for payment_id, payment in payments.items()
                if int(payment["amount_cents"])
                < sum(
                    int(refund["amount_cents"])
                    for refund in refunds
                    if refund["payment_id"] == payment_id
                )
            )
        }
    if scenario == "refund_region":
        return {
            "refund_count": sum(
                payment_customer(payments[row["payment_id"]])["region"] == params["region"]
                for row in refunds
            )
        }
    if scenario == "invoice_count":
        return {
            "invoice_count": sum(
                in_period(orders[row["order_id"]]["ordered_at"], lo, hi)
                for row in invoices.values()
            )
        }
    if task.scenario.clarification:
        return {}
    raise ValueError(f"Unknown scenario {scenario}")


def reference_record(task: Task, values: dict) -> dict:
    if set(values) != {key for key, _, _ in task.scenario.outputs}:
        raise ValueError("Reference outputs differ from declared keys")
    if any(value == [] for value in values.values()):
        raise ValueError("Reconciliation scenario must expose a nonempty discrepancy set")
    if task.scenario.name in {
        "refund_method",
        "cohort_spend",
        "product_units",
        "churn",
        "refund_region",
    }:
        if any(Decimal(value) <= 0 for value in values.values()):
            raise ValueError("Scenario requires a positive discriminating result")
    return {
        "task_key": task.input["task_key"],
        "input_hash": digest(task.input),
        "kind": "clarify" if task.scenario.clarification else "answer",
        "missing_fields": list(task.scenario.clarification),
        "findings": [
            {
                "key": key,
                "unit": unit,
                "value_type": value_type,
                "value": values[key],
                "tolerance": "0.000001"
                if key in {"volume_effect", "average_receipt_effect", "refund_effect", "churn_rate"}
                else "0",
            }
            for key, unit, value_type in task.scenario.outputs
        ],
    }
