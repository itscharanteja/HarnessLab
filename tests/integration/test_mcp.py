import asyncio
import json
import os
import subprocess
from decimal import Decimal
from string import Template

import psycopg
import pytest
from harnesslab_runner.graph import tool_call
from harnesslab_runner.mcp_client import open_dataops

from benchmarks.generators.cli import fixture_seed_dsn, fixture_variants
from benchmarks.generators.data import generate_rows
from benchmarks.generators.database import column, relation
from benchmarks.generators.reference_sql import SQL
from benchmarks.generators.scenarios import python_reference, tasks_for


def test_real_mcp_tools_and_sql_bounds(sandbox, catalog):
    variant, dsn = sandbox()
    table = variant.mapping["orders"]["relation"]
    other = sandbox(variant="d02")[0].schema

    async def run():
        async with open_dataops(dsn, variant.key, catalog) as client:

            async def call(name, **args):
                return await client.call(tool_call(name, **args))

            result = await call("list_tables")
            assert result["data"]["tables"] == sorted(client.tables)
            assert table in result["data"]["tables"]
            result = await call("describe_schema", tables=[table])
            [description] = result["data"]["tables"]
            assert description["name"] == table
            assert description["primary_key"] == [variant.mapping["orders"]["columns"]["id"]]
            assert (
                description["foreign_keys"][0]["table"] == variant.mapping["customers"]["relation"]
            )
            result = await call("get_business_definition", metric_id="cohort_spend")
            assert result["data"]["unit"] == "usd_cents"
            assert result["data"]["catalog_version"] == "synthetic-business-v1"
            result = await call("execute_readonly_sql", sql=f"SELECT count(*) AS n FROM {table}")
            data = result["data"]
            assert data["rows"] == [[600]]
            assert data["columns"] == [{"name": "n", "type": "integer"}]
            evidence = {"kind": "cell", "query_id": data["query_id"], "row": 0, "column": "n"}
            operand = {"source": evidence, "unit": "count"}
            result = await call("validate_calculation", operation="identity", operands=[operand])
            calculation = result["data"]["calculation_id"]
            assert result["data"]["value"] == "600"
            result = await call(
                "validate_calculation",
                operation="ratio",
                operands=[
                    operand,
                    {
                        "source": {"kind": "calculation", "calculation_id": calculation},
                        "unit": "count",
                    },
                ],
            )
            assert result["data"]["value"] == "1" and result["data"]["unit"] == "ratio"
            result = await call(
                "validate_calculation",
                operation="ratio",
                operands=[
                    operand,
                    {**operand, "unit": "usd_cents"},
                ],
            )
            assert result["code"] == "invalid_calculation"
            result = await call(
                "validate_calculation",
                operation="identity",
                operands=[{"source": {**evidence, "query_id": "foreign_query"}, "unit": "count"}],
            )
            assert result["code"] == "evidence_scope"
            result = await call("inspect_query_error", error_id=result["error_id"])
            assert result["data"]["error_class"] == "evidence_scope"
            assert result["data"]["retryable"] is False
            assert (await call("inspect_query_error", error_id="foreign_error"))[
                "code"
            ] == "evidence_scope"
            assert (await call("describe_schema", tables=[table, "foreign_table"]))[
                "code"
            ] == "sql_policy"

            id_col = variant.mapping["orders"]["columns"]["id"]
            for query, code in [
                (f"SELECT {id_col} FROM {table}", "row_limit"),
                (f"SELECT 1 AS n, 2 AS n FROM {table} LIMIT 1", "duplicate_columns"),
                (f"SELECT '{'x' * 500}' FROM {table} LIMIT 150", "byte_limit"),
                (f"SELECT * FROM {other}.{table}", "sql_policy"),
                (f"SELECT missing_col FROM {table}", "schema_error"),
                (f"SELECT pg_catalog.count(*) FROM {table}", "sql_policy"),
                (f"DELETE FROM {table}", "sql_policy"),
                (f"SELECT 1 / 0 FROM {table} LIMIT 1", "invalid_sql"),
            ]:
                result = await call("execute_readonly_sql", sql=query)
                assert result["code"] == code
            result = await call("execute_readonly_sql", sql=f"SELECT count(*) AS n FROM {table}")
            assert result["data"]["rows"] == [[600]]
            result = await call(
                "execute_readonly_sql",
                sql=(
                    f"SELECT '2025-01-01T01:00:00+01:00'::timestamptz AS t, 2.500::numeric AS n "
                    f"FROM {table} LIMIT 1"
                ),
            )
            assert result["data"]["rows"] == [["2025-01-01T00:00:00Z", "2.5"]]

        async with open_dataops(dsn, variant.key, catalog) as other_run:
            result = await other_run.call(
                tool_call("validate_calculation", operation="identity", operands=[operand])
            )
            assert result["code"] == "evidence_scope"

    asyncio.run(run())


def test_runtime_role_denies_writes_without_parser(sandbox):
    variant, dsn = sandbox()
    table = variant.mapping["orders"]["relation"]
    with psycopg.connect(dsn, autocommit=True) as conn:
        assert conn.execute("SHOW default_transaction_read_only").fetchone() == ("on",)
        conn.execute("SET default_transaction_read_only = off")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(f"DELETE FROM {variant.schema}.{table} WHERE false")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("CREATE TEMP TABLE bypass (id int)")
        other, _ = sandbox(variant="d02")
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(f"SELECT * FROM {other.schema}.{other.mapping['orders']['relation']}")


def test_oracle_shaped_bridge_runs_through_policy(sandbox, catalog):
    variant, dsn = sandbox()
    _, variants = fixture_variants("dev")
    datasets = {item.key: generate_rows(item) for item in variants}
    task = next(
        task
        for task in tasks_for(variants, datasets)
        if task.scenario.name == "bridge" and task.input["variant_id"] == variant.key
    )
    expected = python_reference(task, datasets[variant.key])
    with psycopg.connect(dsn, cursor_factory=psycopg.ClientCursor) as conn:
        names = {
            name: relation(variant.mapping, name, variant.schema).as_string(conn)
            for name in variant.mapping
        }
        for name, row in variant.mapping.items():
            names.update(
                {
                    f"{name}_{col}": column(variant.mapping, name, col).as_string(conn)
                    for col in row["columns"]
                }
            )
        query = conn.cursor().mogrify(Template(SQL["bridge"]).substitute(names), task.params)

    async def run():
        async with open_dataops(dsn, variant.key, catalog) as client:
            result = await client.call(tool_call("execute_readonly_sql", sql=query))
            assert result["status"] == "ok", result
            data = result["data"]
            actual = dict(
                zip([col["name"] for col in data["columns"]], data["rows"][0], strict=True)
            )
            for key, value in expected.items():
                if isinstance(value, str):
                    assert Decimal(actual[key]) == Decimal(value)
                else:
                    assert actual[key] == value

    asyncio.run(run())


def test_postgres_lock_timeout_rolls_back(sandbox, catalog):
    variant, dsn = sandbox()
    table = variant.mapping["orders"]["relation"]
    query = tool_call("execute_readonly_sql", sql=f"SELECT count(*) AS n FROM {table}")

    async def run():
        async with open_dataops(dsn, variant.key, catalog) as client:
            with psycopg.connect(fixture_seed_dsn("dev")) as locker:
                locker.execute(f"LOCK TABLE {variant.schema}.{table} IN ACCESS EXCLUSIVE MODE")
                failure = await client.call(query)
                assert failure["code"] == "transient"
                hint = await client.call(
                    tool_call("inspect_query_error", error_id=failure["error_id"])
                )
                assert hint["data"]["retryable"] is True
            recovered = await client.call(query)
            assert recovered["data"]["rows"] == [[600]]

    asyncio.run(run())


def test_runner_image_starts_mcp_with_allowlisted_environment(sandbox):
    variant, dsn = sandbox()
    script = """
import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

from harnesslab_runner import mcp_client
from mcp.client.stdio import get_default_environment
from psycopg.conninfo import make_conninfo

dsn, variant = json.load(sys.stdin)
os.environ["OPENAI_API_KEY"] = "placeholder"
os.environ["CONTROL_DISPATCHER_DSN"] = "placeholder"
catalog = Path(os.environ["HL_METRIC_CATALOG"])
assert importlib.util.find_spec("benchmarks") is None
assert not Path("/workspace/.artifacts").exists()
assert not Path("/workspace/benchmarks").exists()
original_stdio = mcp_client.stdio_client

def checked_stdio(parameters, **options):
    environment = get_default_environment() | parameters.env
    assert "OPENAI_API_KEY" not in environment
    assert "CONTROL_DISPATCHER_DSN" not in environment
    assert set(parameters.env) == {
        "HL_MCP_DSN", "HL_MCP_SCHEMA", "HL_MCP_ROLE", "HL_MCP_CATALOG", "HL_MCP_FAULT"
    }
    return original_stdio(parameters, **options)

mcp_client.stdio_client = checked_stdio

async def run():
    dsn_in_container = make_conninfo(dsn, host="sandbox-db", port=5432)
    async with mcp_client.open_dataops(dsn_in_container, variant, catalog) as client:
        result = await client.call({"name": "list_tables", "arguments": {}})
        assert result["status"] == "ok" and result["data"]["tables"]

asyncio.run(run())
"""
    subprocess.run(
        [
            "docker",
            "compose",
            "--file",
            "infra/docker/compose.yaml",
            "exec",
            "-T",
            "runner",
            "python",
            "-c",
            script,
        ],
        input=json.dumps([dsn, variant.key]),
        text=True,
        check=True,
        timeout=30,
        env=os.environ.copy(),
    )
