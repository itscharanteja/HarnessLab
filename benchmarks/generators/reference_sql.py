from decimal import Decimal
from string import Template

from psycopg.rows import dict_row

from .data import Variant
from .database import Connection, column, relation
from .scenarios import Task

# Only trusted generator queries use these substitutions. Values still use query parameters.
CAPTURES = """
    FROM ${payments} p
    JOIN ${invoices} i ON i.${invoices_id} = p.${payments_invoice_id}
    JOIN ${orders} o ON o.${orders_id} = i.${invoices_order_id}
    JOIN ${customers} c ON c.${customers_id} = o.${orders_customer_id}
"""
REFUNDS = f"""
    {CAPTURES}
    JOIN ${{refunds}} r ON r.${{refunds_payment_id}} = p.${{payments_id}}
"""
CAPTURE_RANGE = """
    p.${payments_status} = 'captured'
    AND p.${payments_captured_at} >= %(lo)s::timestamptz
    AND p.${payments_captured_at} < %(hi)s::timestamptz
"""
REFUND_RANGE = """
    r.${refunds_refunded_at} >= %(lo)s::timestamptz
    AND r.${refunds_refunded_at} < %(hi)s::timestamptz
"""
ORDER_RANGE = """
    o.${orders_ordered_at} >= %(lo)s::timestamptz
    AND o.${orders_ordered_at} < %(hi)s::timestamptz
"""
ACTIVE = """
    s.${subscriptions_plan} = %(plan)s
    AND s.${subscriptions_started_at} <= %(lo)s::timestamptz
    AND (s.${subscriptions_ended_at} IS NULL OR s.${subscriptions_ended_at} > %(lo)s::timestamptz)
"""


def half_even(expression: str) -> str:
    # PostgreSQL round(numeric, scale) rounds ties away from zero.
    # Correct odd millionths when that rule lands on the odd side of an exact half.
    return f"""
        CASE WHEN ({expression}) %% 0.000001 IN (-0.0000005, 0.0000005)
             AND (round(({expression}), 6) * 1000000) %% 2 <> 0
        THEN round(({expression}), 6)
            - CASE WHEN ({expression}) < 0 THEN -0.000001 ELSE 0.000001 END
        ELSE round(({expression}), 6)
        END
    """


BRIDGE_AVERAGE = "oct_gross::numeric(38, 22) / oct_count - sep_gross::numeric(38, 22) / sep_count"
BRIDGE_VOLUME = "(oct_count - sep_count) * sep_gross::numeric(38, 22) / sep_count"
SQL = {
    "paid_orders": f"""
        SELECT count(DISTINCT o.${{orders_id}}) AS paid_order_count
        {CAPTURES} WHERE {CAPTURE_RANGE}
    """,
    "bridge": f"""
        WITH captured AS (
            SELECT
                count(DISTINCT o.${{orders_id}}) FILTER (
                    WHERE p.${{payments_captured_at}} < %(oct_lo)s::timestamptz
                ) AS sep_count,
                count(DISTINCT o.${{orders_id}}) FILTER (
                    WHERE p.${{payments_captured_at}} >= %(oct_lo)s::timestamptz
                ) AS oct_count,
                sum(p.${{payments_amount_cents}}) FILTER (
                    WHERE p.${{payments_captured_at}} < %(oct_lo)s::timestamptz
                ) AS sep_gross,
                sum(p.${{payments_amount_cents}}) FILTER (
                    WHERE p.${{payments_captured_at}} >= %(oct_lo)s::timestamptz
                ) AS oct_gross
            {CAPTURES}
            WHERE p.${{payments_status}} = 'captured' AND c.${{customers_region}} = %(region)s
                AND p.${{payments_captured_at}} >= %(sep_lo)s::timestamptz
                AND p.${{payments_captured_at}} < %(oct_hi)s::timestamptz
        ), refunded AS (
            SELECT
                coalesce(sum(r.${{refunds_amount_cents}}) FILTER (
                    WHERE r.${{refunds_refunded_at}} < %(oct_lo)s::timestamptz
                ), 0) AS sep_refunds,
                coalesce(sum(r.${{refunds_amount_cents}}) FILTER (
                    WHERE r.${{refunds_refunded_at}} >= %(oct_lo)s::timestamptz
                ), 0) AS oct_refunds
            {REFUNDS}
            WHERE c.${{customers_region}} = %(region)s
                AND r.${{refunds_refunded_at}} >= %(sep_lo)s::timestamptz
                AND r.${{refunds_refunded_at}} < %(oct_hi)s::timestamptz
        )
        SELECT
            sep_gross - sep_refunds AS sep_net_receipts,
            oct_gross - oct_refunds AS oct_net_receipts,
            sep_count AS sep_paid_order_count,
            oct_count AS oct_paid_order_count,
            {half_even(BRIDGE_VOLUME)} AS volume_effect,
            {half_even(f"oct_count * ({BRIDGE_AVERAGE})")} AS average_receipt_effect,
            round((sep_refunds - oct_refunds)::numeric, 6) AS refund_effect
        FROM captured CROSS JOIN refunded
    """,
    "duplicate_payments": f"""
        SELECT DISTINCT p.${{payments_invoice_id}} AS invoice_ids
        FROM ${{payments}} p WHERE {CAPTURE_RANGE}
        GROUP BY p.${{payments_invoice_id}}, p.${{payments_captured_at}},
            p.${{payments_amount_cents}}, p.${{payments_method}}
        HAVING count(*) > 1
        ORDER BY invoice_ids
    """,
    "net_receipts": f"""
        SELECT
            (SELECT coalesce(sum(p.${{payments_amount_cents}}), 0)
             FROM ${{payments}} p WHERE {CAPTURE_RANGE})
            - (SELECT coalesce(sum(r.${{refunds_amount_cents}}), 0)
               FROM ${{refunds}} r WHERE {REFUND_RANGE})
            AS net_receipts
    """,
    "order_status": f"""
        SELECT count(*) AS order_count FROM ${{orders}} o
        WHERE {ORDER_RANGE} AND o.${{orders_status}} = %(status)s
    """,
    "refund_method": f"""
        SELECT coalesce(sum(r.${{refunds_amount_cents}}), 0) AS refund_total
        {REFUNDS} WHERE {REFUND_RANGE} AND p.${{payments_method}} = %(method)s
    """,
    "cohort_spend": f"""
        SELECT coalesce(sum(p.${{payments_amount_cents}}), 0) AS cohort_spend {CAPTURES}
        WHERE {CAPTURE_RANGE}
            AND c.${{customers_signup_at}} >= %(cohort_lo)s::timestamptz
            AND c.${{customers_signup_at}} < %(cohort_hi)s::timestamptz
    """,
    "invoice_balance": f"""
        SELECT i.${{invoices_id}} AS invoice_ids
        FROM ${{invoices}} i
        JOIN ${{orders}} o ON o.${{orders_id}} = i.${{invoices_order_id}}
        LEFT JOIN ${{payments}} p ON p.${{payments_invoice_id}} = i.${{invoices_id}}
            AND p.${{payments_status}} = 'captured'
        WHERE {ORDER_RANGE} AND i.${{invoices_status}} = 'paid'
        GROUP BY i.${{invoices_id}}, i.${{invoices_total_cents}}
        HAVING i.${{invoices_total_cents}} <> coalesce(sum(p.${{payments_amount_cents}}), 0)
        ORDER BY invoice_ids
    """,
    "product_units": f"""
        SELECT coalesce(sum(l.${{order_items_quantity}}), 0) AS product_units
        FROM ${{order_items}} l
        JOIN ${{orders}} o ON o.${{orders_id}} = l.${{order_items_order_id}}
        JOIN ${{products}} p ON p.${{products_id}} = l.${{order_items_product_id}}
        WHERE {ORDER_RANGE} AND p.${{products_sku}} = %(sku)s
    """,
    "sku_price": """
        SELECT p.${products_unit_price_cents} AS unit_price
        FROM ${products} p WHERE p.${products_sku} = %(sku)s
    """,
    "active_plan": f"""
        SELECT count(DISTINCT s.${{subscriptions_customer_id}}) AS active_count
        FROM ${{subscriptions}} s WHERE {ACTIVE}
    """,
    "churn": f"""
        WITH cohort AS (
            SELECT count(*) AS active_count,
                count(*) FILTER (WHERE s.${{subscriptions_ended_at}} < %(hi)s::timestamptz)
                    AS terminations
            FROM ${{subscriptions}} s WHERE {ACTIVE}
        )
        SELECT {half_even("terminations::numeric(38, 22) / active_count")} AS churn_rate FROM cohort
    """,
    "excess_refund": f"""
        SELECT p.${{payments_id}} AS payment_ids
        FROM ${{payments}} p JOIN ${{refunds}} r ON r.${{refunds_payment_id}} = p.${{payments_id}}
        WHERE {REFUND_RANGE} AND p.${{payments_status}} = 'captured'
        GROUP BY p.${{payments_id}}, p.${{payments_amount_cents}}
        HAVING sum(r.${{refunds_amount_cents}}) > p.${{payments_amount_cents}}
        ORDER BY payment_ids
    """,
    "refund_region": f"""
        SELECT count(*) AS refund_count {REFUNDS}
        WHERE {REFUND_RANGE} AND c.${{customers_region}} = %(region)s
    """,
    "invoice_count": f"""
        SELECT count(*) AS invoice_count
        FROM ${{invoices}} i JOIN ${{orders}} o ON o.${{orders_id}} = i.${{invoices_order_id}}
        WHERE {ORDER_RANGE}
    """,
}


def postgres_reference(conn: Connection, variant: Variant, schema: str, task: Task) -> dict:
    if task.scenario.clarification:
        return {}
    mapping = variant.mapping
    names = {table: relation(mapping, table, schema).as_string(conn) for table in mapping}
    names.update(
        {
            f"{table}_{key}": column(mapping, table, key).as_string(conn)
            for table, details in mapping.items()
            for key in details["columns"]
        }
    )
    query = Template(SQL[task.scenario.name]).substitute(names)
    with conn.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(query, task.params).fetchall()
    outputs = task.scenario.outputs
    if len(outputs) == 1 and outputs[0][2] == "integer_set":
        key = outputs[0][0]
        return {key: [row[key] for row in rows]}
    if len(rows) != 1:
        raise ValueError("Expected a single reference result row")
    return {
        key: format(Decimal(rows[0][key]), "f") if value_type == "decimal" else rows[0][key]
        for key, _unit, value_type in outputs
    }
