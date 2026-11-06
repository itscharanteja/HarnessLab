from collections import defaultdict
from dataclasses import dataclass
from hashlib import sha256

import rfc8785

DATASET = "synthetic-business-v1"
GENERATOR_REVISION = "1"
REGIONS = ("North", "South", "East", "West")
METHODS = ("card", "wallet", "bank")
PLANS = ("basic", "growth", "pro")
STATUSES = ("paid", "open", "cancelled")

type Scalar = int | str | None
type Row = dict[str, Scalar]
type Rows = dict[str, list[Row]]


@dataclass(frozen=True)
class Table:
    columns: dict[str, str]
    pk: tuple[str, ...] = ("id",)
    fks: tuple[tuple[str, str], ...] = ()


TABLES = {
    "customers": Table({"id": "integer", "region": "text", "signup_at": "timestamptz"}),
    "products": Table({"id": "integer", "sku": "text", "unit_price_cents": "integer"}),
    "orders": Table(
        {"id": "integer", "customer_id": "integer", "ordered_at": "timestamptz", "status": "text"},
        fks=(("customer_id", "customers"),),
    ),
    "order_items": Table(
        {
            "order_id": "integer",
            "product_id": "integer",
            "quantity": "integer",
            "unit_price_cents": "integer",
        },
        pk=("order_id", "product_id"),
        fks=(("order_id", "orders"), ("product_id", "products")),
    ),
    "invoices": Table(
        {"id": "integer", "order_id": "integer", "status": "text", "total_cents": "integer"},
        fks=(("order_id", "orders"),),
    ),
    "payments": Table(
        {
            "id": "integer",
            "invoice_id": "integer",
            "captured_at": "timestamptz",
            "amount_cents": "integer",
            "method": "text",
            "status": "text",
        },
        fks=(("invoice_id", "invoices"),),
    ),
    "refunds": Table(
        {
            "id": "integer",
            "payment_id": "integer",
            "refunded_at": "timestamptz",
            "amount_cents": "integer",
        },
        fks=(("payment_id", "payments"),),
    ),
    "subscriptions": Table(
        {
            "id": "integer",
            "customer_id": "integer",
            "plan": "text",
            "started_at": "timestamptz",
            "ended_at": "timestamptz",
        },
        fks=(("customer_id", "customers"),),
    ),
}

RELATION_ALIASES = {
    "customers": ("accounts", "buyers", "client_directory"),
    "products": ("catalog_items", "merchandise", "inventory"),
    "orders": ("purchases", "sales_orders", "transactions"),
    "order_items": ("line_items", "purchase_lines", "order_detail"),
    "invoices": ("billing_documents", "bills", "invoice_headers"),
    "payments": ("receipts", "captures", "payment_events"),
    "refunds": ("credits", "reimbursements", "returns"),
    "subscriptions": ("memberships", "plans_enrolled", "recurring_accounts"),
}

COLUMN_ALIASES = {
    "id": "key",
    "region": "market",
    "signup_at": "joined_on",
    "sku": "item_code",
    "unit_price_cents": "unit_usd_cents",
    "customer_id": "account_key",
    "ordered_at": "purchased_on",
    "status": "state",
    "order_id": "purchase_key",
    "product_id": "item_key",
    "quantity": "units",
    "total_cents": "invoice_usd_cents",
    "invoice_id": "billing_key",
    "captured_at": "received_on",
    "amount_cents": "usd_cents",
    "method": "channel",
    "payment_id": "receipt_key",
    "refunded_at": "credited_on",
    "plan": "tier",
    "started_at": "active_from",
    "ended_at": "active_until",
}


def canonical(value: object) -> bytes:
    return rfc8785.dumps(value)


def digest(value: object) -> str:
    return sha256(canonical(value)).hexdigest()


def keyed(seed: str, namespace: str, stable_id: str) -> int:
    parts = [part.encode("utf-8") for part in (seed, namespace, stable_id)]
    data = b"".join(len(part).to_bytes(4, "big") + part for part in parts)
    return int.from_bytes(sha256(data).digest()[:8], "big")


def choose[T](seed: str, namespace: str, stable_id: str, values: tuple[T, ...]) -> T:
    return values[keyed(seed, namespace, stable_id) % len(values)]


def ordered[T](seed: str, namespace: str, values: tuple[T, ...]) -> tuple[T, ...]:
    return tuple(sorted(values, key=lambda value: (keyed(seed, namespace, str(value)), str(value))))


def timestamp(month: int, day: int = 1, hour: int = 0) -> str:
    return f"2025-{month:02d}-{day:02d}T{hour:02d}:00:00Z"


def period(month: int) -> tuple[str, str]:
    return timestamp(month), timestamp(month + 1) if month < 12 else "2026-01-01T00:00:00Z"


@dataclass(frozen=True)
class Variant:
    split: str
    key: str
    seed: str

    @property
    def schema(self) -> str:
        return f"hl_{self.key}"

    @property
    def role(self) -> str:
        return f"hl_read_{self.key}"

    @property
    def mapping(self) -> dict:
        relation_order = ordered(self.seed, "relation-order", tuple(TABLES))
        return {
            table: {
                "relation": (
                    choose(self.seed, "relation", table, RELATION_ALIASES[table]) + "_" + self.key
                ),
                "columns": {
                    column: COLUMN_ALIASES[column]
                    if keyed(self.seed, table, column) % 2
                    else column
                    for column in ordered(
                        self.seed, f"{table}-column-order", tuple(TABLES[table].columns)
                    )
                },
            }
            for table in relation_order
        }


def generate_rows(variant: Variant) -> Rows:
    seed = variant.seed
    rows: Rows = {table: [] for table in TABLES}
    for customer in range(1, 201):
        stable = str(customer)
        rows["customers"].append(
            {
                "id": customer,
                "region": REGIONS[(customer - 1) % len(REGIONS)],
                "signup_at": timestamp(
                    choose(seed, "signup-month", stable, tuple(range(1, 13))),
                    choose(seed, "signup-day", stable, tuple(range(1, 29))),
                ),
            }
        )
    for product in range(1, 21):
        rows["products"].append(
            {
                "id": product,
                "sku": f"SKU-{product:03d}",
                "unit_price_cents": 1200 + keyed(seed, "price", str(product)) % 8801,
            }
        )

    september = 43 + keyed(seed, "volume", "sep") % 11
    october = 63 + keyed(seed, "volume", "oct") % 13
    ordinary, extra = divmod(600 - september - october, 10)
    months = {m: ordinary + (i < extra) for i, m in enumerate((1, 2, 3, 4, 5, 6, 7, 8, 11, 12))}
    months.update({9: september, 10: october})
    anomaly_payments: dict[int, list[Row]] = defaultdict(list)
    order = 0
    for month, count in sorted(months.items()):
        for slot in range(count):
            order += 1
            stable = str(order)
            day = 1 + keyed(seed, "order-day", stable) % 28
            date = timestamp(month, day, keyed(seed, "order-hour", stable) % 24)
            customer = 1 + keyed(seed, "customer", stable) % 200
            if slot < 12:
                customer = 1 + slot % 4 + 4 * (keyed(seed, "early-customer", stable) % 50)
            status = (
                "paid" if slot < 12 else choose(seed, "status", stable, (*STATUSES, "paid", "paid"))
            )
            rows["orders"].append(
                {"id": order, "customer_id": customer, "ordered_at": date, "status": status}
            )
            items = ordered(seed, f"items-{stable}", tuple(range(1, 21)))
            total = 0
            for product in items[: 1 + keyed(seed, "item-count", stable) % 3]:
                quantity = 1 + keyed(seed, "quantity", f"{stable}-{product}") % 4
                base = int(rows["products"][product - 1]["unit_price_cents"])
                price = base + (80 + keyed(seed, "oct-price", stable) % 220 if month == 10 else 0)
                rows["order_items"].append(
                    {
                        "order_id": order,
                        "product_id": product,
                        "quantity": quantity,
                        "unit_price_cents": price,
                    }
                )
                total += price * quantity
            rows["invoices"].append(
                {"id": order, "order_id": order, "status": status, "total_cents": total}
            )
            if status != "paid":
                continue
            payment = {
                "id": order,
                "invoice_id": order,
                "captured_at": date,
                "amount_cents": total,
                "method": choose(seed, "method", stable, METHODS),
                "status": "captured",
            }
            rows["payments"].append(payment)
            if slot < 3:
                anomaly_payments[month].append(payment)
            refund_rate = 35 + keyed(seed, "refund-rate", str(month)) % 80
            if month == 10:
                refund_rate += 100
            if slot >= 3 and keyed(seed, "refund", stable) % 1000 < refund_rate:
                rows["refunds"].append(
                    {
                        "id": order,
                        "payment_id": order,
                        "refunded_at": date,
                        "amount_cents": 1
                        + keyed(seed, "refund-amount", stable) % max(1, total // 2),
                    }
                )

    for month in (9, 10):
        duplicate, unmatched, over_refunded = anomaly_payments[month]
        rows["payments"].append({**duplicate, "id": 1000 + month})
        unmatched["amount_cents"] = int(unmatched["amount_cents"]) - 125
        rows["refunds"].append(
            {
                "id": 1000 + month,
                "payment_id": over_refunded["id"],
                "refunded_at": over_refunded["captured_at"],
                "amount_cents": int(over_refunded["amount_cents"]) + 99,
            }
        )
    for subscription in range(1, 81):
        stable = str(subscription)
        if subscription <= 24:
            plan = PLANS[(subscription - 1) % 3]
            start = timestamp(1, subscription)
            end = timestamp(5 + (subscription - 1) // 3, 15)
        else:
            plan = choose(seed, "plan", stable, PLANS)
            month = 1 + keyed(seed, "subscription-start", stable) % 6
            start = timestamp(month, 1 + keyed(seed, "subscription-day", stable) % 25)
            end = (
                timestamp(month + 4, 16)
                if keyed(seed, "subscription-end", stable) % 4 == 0
                else None
            )
        rows["subscriptions"].append(
            {
                "id": subscription,
                "customer_id": 1 + keyed(seed, "subscriber", stable) % 200,
                "plan": plan,
                "started_at": start,
                "ended_at": end,
            }
        )
    return sort_rows(rows)


def sort_rows(rows: Rows) -> Rows:
    return {
        table: sorted(entries, key=lambda row: tuple(row[key] for key in TABLES[table].pk))
        for table, entries in rows.items()
    }
