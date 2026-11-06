import re
from string import Template

import pytest
from harnesslab_mcp.sql_policy import QueryRejected, check_query

from benchmarks.generators.cli import fixture_variants
from benchmarks.generators.reference_sql import SQL
from benchmarks.generators.scenarios import SCENARIOS


@pytest.mark.parametrize(
    "source",
    [
        "DELETE FROM test_d01",
        "CREATE TABLE x (i int)",
        "COPY test_d01 TO STDOUT",
        "SELECT id INTO x FROM test_d01",
        "SELECT id FROM test_d01; SELECT id FROM test_d01",
        "SELECT id FROM test_d01 FOR UPDATE",
        "WITH x AS (DELETE FROM test_d01 RETURNING id) SELECT id FROM x",
        "WITH RECURSIVE x AS (SELECT id FROM test_d01) SELECT id FROM x",
        "SELECT id FROM pg_catalog.pg_roles",
        "SELECT id FROM pg_roles",
        "SELECT id FROM hl_d02.test_d02",
        "SELECT id FROM test_d02",
        "SELECT id FROM made_up_schema.test_d01",
        "SELECT id FROM test_v0123456789ab",
        "SELECT ctid FROM test_d01",
        "SELECT t.tableoid FROM test_d01 t",
        "SELECT pg_catalog.count(*) FROM test_d01",
        "SELECT pg_sleep(5) FROM test_d01",
        "SELECT count(*) FROM generate_series(1, 10)",
        "SELECT id OPERATOR(pg_catalog.+) 1 FROM test_d01",
        "SELECT id ^ 2 FROM test_d01",
        "SELECT id::regclass FROM test_d01",
        "SELECT id::public.numeric FROM test_d01",
        "SELECT id FROM test_d01 ORDER BY id USING <",
        "SELECT id FROM test_d01 NATURAL JOIN test_d01",
        "SELECT id FROM test_d01 WHERE EXISTS (SELECT 1 FROM pg_authid)",
        "SELECT id FROM test_d01 WHERE EXISTS (SELECT 1 FROM test_d01 FOR UPDATE)",
    ],
)
def test_sql_bypasses_rejected(source):
    with pytest.raises(QueryRejected, match="sql_policy"):
        check_query(source, "hl_d01", {"test_d01"})


@pytest.mark.parametrize(
    ("source", "code"),
    [
        ("select * fro test_d01", "syntax_error"),
        ("select * from orders", "missing_relation"),
        ("select * from test_d01 " + " " * 8192, "sql_too_large"),
    ],
)
def test_invalid_unresolved_and_size_are_classified(source, code):
    with pytest.raises(QueryRejected, match=code):
        check_query(source, "hl_d01", {"test_d01"})


def test_canonical_fingerprints_qualify_relations_and_ignore_spacing():
    tables = {"test_d01"}
    first = check_query("SELECT id FROM test_d01 -- ignored", "hl_d01", tables)
    second = check_query("select id from hl_d01.test_d01;", "hl_d01", tables)
    assert first == second
    assert "ONLY hl_d01.test_d01" in first.sql


@pytest.mark.parametrize(
    ("split", "scenario"),
    [
        (split, scenario.name)
        for split, scenarios in SCENARIOS.items()
        for scenario in scenarios
        if scenario.name in SQL
    ],
)
def test_oracle_query_shapes_pass(split, scenario):
    variant = fixture_variants(split)[1][0]
    mapping = variant.mapping
    substitutions = {name: row["relation"] for name, row in mapping.items()}
    for name, row in mapping.items():
        substitutions.update(
            {f"{name}_{col}": physical for col, physical in row["columns"].items()}
        )
    query = Template(SQL[scenario]).substitute(substitutions)
    query = re.sub(r"%\([a-z_]+\)s", "'2025-10-01'", query).replace("%%", "%")
    allowed = {row["relation"] for row in mapping.values()}
    assert check_query(query, variant.schema, allowed).relations
