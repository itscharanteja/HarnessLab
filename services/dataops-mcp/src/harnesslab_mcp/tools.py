import json
import re
from datetime import UTC, date, datetime
from decimal import Context, Decimal, DecimalException, localcontext
from hashlib import sha256

import psycopg
from harnesslab_contracts.validate import accepts
from psycopg import sql
from psycopg.rows import dict_row

from .sql_policy import QueryRejected, check_query

MAX_RESPONSE_BYTES = 65536
MAX_ROWS = 200
SAFE_INTEGER = 2**53 - 1
COLUMN_TYPES = {
    16: "boolean",
    20: "integer",
    21: "integer",
    23: "integer",
    25: "string",
    1042: "string",
    1043: "string",
    1082: "date",
    1114: "timestamp",
    1184: "timestamp",
    1700: "decimal",
}
SQLSTATES = {
    "42703": "schema_error",
    "42P01": "missing_relation",
    "42601": "syntax_error",
    "42803": "invalid_sql",
    "42804": "invalid_sql",
    "42883": "invalid_sql",
    "42501": "sql_policy",
    "57014": "timeout",
    "55P03": "transient",
    "40001": "transient",
    "40P01": "transient",
    "22012": "invalid_sql",
}
TRANSIENT = {"timeout", "transient"}
HINTS = {
    "timeout": "Reduce the work or retry once if the harness permits it.",
    "transient": "Retry once if the harness permits it.",
    "schema_error": "Inspect the relevant tables and revise the query.",
    "missing_relation": "Discover the current physical table names and revise the query.",
    "syntax_error": "Revise the query syntax.",
    "malformed_result": "Revise the query before retrying.",
    "sql_policy": "Use the allowed read-only SQL and current variant.",
}


def json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


def sql_payload_hash(columns: list, rows: list) -> str:
    return sha256(json_bytes({"columns": columns, "rows": rows})).hexdigest()


def hint(error_id: str, code: str) -> dict:
    return {
        "error_id": error_id,
        "error_class": code,
        "retryable": code in TRANSIENT,
        "hint": HINTS.get(code, "Review the call and the tool contract."),
    }


def decimal_string(value: Decimal) -> str:
    if not value.is_finite() or abs(value.adjusted()) > 100:
        raise QueryRejected("unsupported_value")
    text = format(value, "f")
    return (text.rstrip("0").rstrip(".") if "." in text else text) if value else "0"


def scalar(value):
    if isinstance(value, Decimal):
        return decimal_string(value)
    if isinstance(value, datetime):
        return (
            value.replace(tzinfo=value.tzinfo or UTC)
            .astimezone(UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )
    if isinstance(value, date):
        return value.isoformat()
    if type(value) is int and abs(value) > SAFE_INTEGER:
        raise QueryRejected("unsupported_value")
    if isinstance(value, str) and (len(value) > 8192 or "\x00" in value):
        raise QueryRejected("unsupported_value")
    if value is None or isinstance(value, (str, int, bool)):
        return value
    raise QueryRejected("unsupported_value")


class Tools:
    def __init__(self, conn, schema: str, role: str, catalog: dict, fault: dict | None):
        if not re.fullmatch(r"hl_[a-z0-9_]{1,60}", schema):
            raise ValueError("Invalid sandbox schema")
        self.conn = conn
        self.schema = schema
        self.metrics = {
            metric["metric_id"]: {"catalog_version": catalog["catalog_version"], **metric}
            for metric in catalog["metrics"]
        }
        self.units = {metric["unit"] for metric in self.metrics.values()} | {"ratio", "count"}
        self.fault = fault
        self.fault_used = False
        self.errors: dict[str, str] = {}
        self.queries: dict[str, dict] = {}
        self.calculations: dict[str, dict] = {}
        with conn.transaction():
            self.restrict_transaction()
            with conn.cursor(row_factory=dict_row) as cursor:
                principal = cursor.execute("""
                    SELECT rolname, rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication
                        OR rolbypassrls OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
                                                   WHERE member = r.oid) AS elevated
                    FROM pg_catalog.pg_roles r WHERE rolname = current_user
                    """).fetchone()
                if principal != {"rolname": role, "elevated": False}:
                    raise ValueError("Invalid sandbox role")
                self.tables = {
                    row["relname"]
                    for row in cursor.execute(
                        """
                        SELECT c.relname FROM pg_catalog.pg_class c
                        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = %s AND c.relkind = 'r'
                            AND has_table_privilege(c.oid, 'SELECT')
                        """,
                        (schema,),
                    )
                }
        if not self.tables or len(self.tables) > 64:
            raise ValueError("Invalid sandbox relations")

    def restrict_transaction(self):
        self.conn.execute("SET TRANSACTION READ ONLY")
        self.conn.execute("SET LOCAL statement_timeout = '2s'")
        self.conn.execute("SET LOCAL lock_timeout = '250ms'")
        self.conn.execute("SET LOCAL TIME ZONE 'UTC'")
        self.conn.execute("SET LOCAL standard_conforming_strings = on")
        self.conn.execute(
            sql.SQL("SET LOCAL search_path TO pg_catalog, {}").format(sql.Identifier(self.schema))
        )

    def error(self, name: str, code: str) -> dict:
        error_id = f"error_{len(self.errors) + 1}"
        self.errors[error_id] = code
        return {"status": "error", "name": name, "error_id": error_id, "code": code}

    def list_tables(self) -> dict:
        return {"tables": sorted(self.tables)}

    def describe_schema(self, tables: list[str]) -> dict:
        if set(tables) - self.tables:
            raise QueryRejected("sql_policy")
        with self.conn.transaction():
            self.restrict_transaction()
            with self.conn.cursor(row_factory=dict_row) as cursor:
                descriptions = []
                for table in sorted(set(tables)):
                    columns = cursor.execute(
                        """
                        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                               NOT a.attnotnull AS nullable
                        FROM pg_catalog.pg_attribute a
                        WHERE a.attrelid = to_regclass(format('%%I.%%I', %s::text, %s::text))
                              AND a.attnum > 0 AND NOT a.attisdropped
                        ORDER BY a.attname COLLATE "C"
                        """,
                        (self.schema, table),
                    ).fetchall()
                    keys = cursor.execute(
                        """
                        SELECT k.contype, ref.relname AS target,
                            ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY u(num, ord)
                                  JOIN pg_catalog.pg_attribute a
                                  ON a.attrelid = k.conrelid AND a.attnum = u.num
                                  ORDER BY u.ord) AS columns,
                            ARRAY(SELECT a.attname
                                  FROM unnest(k.confkey) WITH ORDINALITY u(num, ord)
                                  JOIN pg_catalog.pg_attribute a
                                  ON a.attrelid = k.confrelid AND a.attnum = u.num
                                  ORDER BY u.ord) AS references
                        FROM pg_catalog.pg_constraint k
                        LEFT JOIN pg_catalog.pg_class ref ON ref.oid = k.confrelid
                        LEFT JOIN pg_catalog.pg_namespace ns ON ns.oid = ref.relnamespace
                        WHERE k.conrelid = to_regclass(format('%%I.%%I', %s::text, %s::text))
                            AND (k.contype = 'p' OR (k.contype = 'f' AND ns.nspname = %s))
                        ORDER BY ref.relname COLLATE "C", k.conname COLLATE "C"
                        """,
                        (self.schema, table, self.schema),
                    ).fetchall()
                    descriptions.append(
                        {
                            "name": table,
                            "columns": columns,
                            "primary_key": next(
                                (k["columns"] for k in keys if k["contype"] == "p"), []
                            ),
                            "foreign_keys": [
                                {
                                    "table": k["target"],
                                    "columns": k["columns"],
                                    "references": k["references"],
                                }
                                for k in keys
                                if k["contype"] == "f" and k["target"] in self.tables
                            ],
                        }
                    )
        return {"tables": descriptions}

    def execute_readonly_sql(self, sql: str) -> dict:
        return self.query(sql)

    def query(self, source: str) -> dict:
        checked = check_query(source, self.schema, self.tables)
        if self.fault and not self.fault_used:
            self.fault_used = True
            if self.fault["kind"] == "malformed_result":
                return {"injected_malformed_result": True}
            raise QueryRejected(self.fault["kind"])

        with self.conn.transaction():
            self.restrict_transaction()
            # Approved relations are schema-qualified by the policy. Resolve functions and
            # operators exclusively from PostgreSQL's built-ins during model SQL execution.
            self.conn.execute("SET LOCAL search_path TO pg_catalog")
            # Only the reconstructed allowlisted AST can reach this statement.
            cursor = self.conn.execute(f"SELECT * FROM ({checked.sql}) AS hl_result LIMIT 201")
            columns = [
                {"name": item.name, "type": COLUMN_TYPES.get(item.type_code)}
                for item in cursor.description
            ]
            if len(columns) > 200 or any(not col["type"] for col in columns):
                raise QueryRejected("unsupported_value")
            if len({col["name"] for col in columns}) != len(columns):
                raise QueryRejected("duplicate_columns")
            rows = []
            row_bytes = 0
            for row in cursor:
                if len(rows) == MAX_ROWS:
                    raise QueryRejected("row_limit")
                encoded = [scalar(value) for value in row]
                row_bytes += len(json_bytes(encoded)) + 1
                if row_bytes > MAX_RESPONSE_BYTES:
                    raise QueryRejected("byte_limit")
                rows.append(encoded)

        query_id = f"query_{len(self.queries) + 1}"
        data = {
            "query_id": query_id,
            "columns": columns,
            "rows": rows,
            "payload_hash": sql_payload_hash(columns, rows),
        }
        if (
            len(json_bytes({"status": "ok", "name": "execute_readonly_sql", "data": data}))
            > MAX_RESPONSE_BYTES
        ):
            raise QueryRejected("byte_limit")
        if not accepts("ExecuteReadonlySqlData", data):
            raise QueryRejected("unsupported_value")
        self.queries[query_id] = data
        return data

    def get_business_definition(self, metric_id: str) -> dict:
        if metric_id not in self.metrics:
            raise QueryRejected("unknown_metric")
        return self.metrics[metric_id]

    def inspect_query_error(self, error_id: str) -> dict:
        if error_id not in self.errors:
            raise QueryRejected("evidence_scope")
        return hint(error_id, self.errors[error_id])

    def validate_calculation(self, operation: str, operands: list[dict]) -> dict:
        if (
            (operation == "identity" and len(operands) != 1)
            or (operation in {"difference", "product", "ratio"} and len(operands) != 2)
            or (operation == "sum" and len(operands) < 2)
        ):
            raise QueryRejected("invalid_calculation")
        values = []
        units = [operand["unit"] for operand in operands]
        for operand in operands:
            ref, unit = operand["source"], operand["unit"]
            if unit not in self.units:
                raise QueryRejected("invalid_calculation")
            if ref["kind"] == "calculation":
                evidence = self.calculations.get(ref["calculation_id"])
                if evidence is None:
                    raise QueryRejected("evidence_scope")
                if evidence["unit"] != unit:
                    raise QueryRejected("invalid_calculation")
                values.append(Decimal(evidence["value"]))
            else:
                evidence = self.queries.get(ref["query_id"])
                if evidence is None:
                    raise QueryRejected("evidence_scope")
                column = next(
                    (
                        i
                        for i, col in enumerate(evidence["columns"])
                        if col["name"] == ref["column"] and col["type"] in {"integer", "decimal"}
                    ),
                    None,
                )
                if column is None or ref["row"] >= len(evidence["rows"]):
                    raise QueryRejected("invalid_calculation")
                value = evidence["rows"][ref["row"]][column]
                if value is None:
                    raise QueryRejected("invalid_calculation")
                values.append(Decimal(value))
        unit = units[0]
        try:
            with localcontext(Context(prec=38)):
                if operation in {"sum", "difference", "identity"}:
                    if len(set(units)) != 1:
                        raise QueryRejected("invalid_calculation")
                    result = values[0] - values[1] if operation == "difference" else sum(values)
                elif operation == "product" and "ratio" in units:
                    unit = units[1] if unit == "ratio" else unit
                    result = values[0] * values[1]
                elif operation == "ratio" and (units[0] == units[1] or units[1] == "ratio"):
                    unit = "ratio" if units[0] == units[1] else unit
                    result = values[0] / values[1]
                else:
                    raise QueryRejected("invalid_calculation")
        except DecimalException:
            raise QueryRejected("invalid_calculation") from None
        key = f"calculation_{len(self.calculations) + 1}"
        data = {
            "calculation_id": key,
            "value": decimal_string(result),
            "unit": unit,
            "sources": operands,
        }
        if not accepts("ValidateCalculationData", data):
            raise QueryRejected("unsupported_value")
        self.calculations[key] = data
        return data


def postgres_error(exc: psycopg.Error) -> str:
    return SQLSTATES.get(exc.sqlstate, "sandbox_unavailable" if not exc.sqlstate else "invalid_sql")
