import json
import subprocess
from collections import Counter
from pathlib import Path
from unicodedata import normalize

import psycopg
import pytest
from psycopg import errors, sql

from benchmarks.generators.cli import (
    ROOT,
    VARIANT_COUNTS,
    build_split,
    fixture_seed_dsn,
    fixture_variants,
    publish,
    read_bundle,
    verify_fixture,
)
from benchmarks.generators.database import column, relation
from benchmarks.generators.scenarios import CATEGORIES, COUNTS, SCENARIOS

ARTIFACTS = ROOT / ".artifacts" / "benchmark-fixture"


def test_split_rosters_and_reference_hashes():
    prompt_keys = set()
    variant_keys = set()
    families = set()
    for split, counts in COUNTS.items():
        bundle = read_bundle(ARTIFACTS, split)
        manifest = bundle["manifest"]
        variants = {variant["id"] for variant in manifest["variants"]}
        assert manifest["fixture"]
        assert len(variants) == VARIANT_COUNTS[split]
        assert variants.isdisjoint(variant_keys)
        variant_keys.update(variants)
        assert Counter(row["variant_id"] for row in manifest["tasks"]) == dict.fromkeys(
            variants, 10
        )
        assert Counter(row["category"] for row in manifest["tasks"]) == dict(
            zip(
                CATEGORIES,
                counts,
                strict=True,
            )
        )
        scenario_keys = {scenario.name for scenario in SCENARIOS[split]}
        assert scenario_keys.isdisjoint(families)
        families.update(scenario_keys)
        for pair, task_meta in zip(bundle["prompts"], manifest["tasks"], strict=True):
            task = pair["task"]
            assert task["task_key"] == task_meta["id"]
            assert task["split"] == split
            key = " ".join(normalize("NFC", task["prompt"]).casefold().split())
            assert key not in prompt_keys
            prompt_keys.add(key)
            assert bool(pair["fault"]) == (task["category"] == "tool_failures")
    assert len(prompt_keys) == 120


@pytest.mark.parametrize("split", list(COUNTS))
def test_clean_regeneration_matches_seeded_replay(split: str, tmp_path: Path):
    revision, variants = fixture_variants(split)
    dsn = fixture_seed_dsn(split)
    verify_fixture(ARTIFACTS, split, dsn)
    bundle = build_split(variants, revision, dsn, fixture=True)
    publish(tmp_path, split, bundle)
    publish(tmp_path, split, bundle)
    for name in bundle:
        filename = f"{name}.json"
        assert (tmp_path / split / filename).read_bytes() == (
            ARTIFACTS / split / filename
        ).read_bytes()
    if split == "dev":
        for name in ("prompts", "oracles", "manifest"):
            source = ROOT / "benchmarks" / "development" / f"{name}.json"
            assert json.loads(source.read_text(encoding="utf-8")) == bundle[name]


def test_variant_login_permissions():
    _, variants = fixture_variants("dev")
    first, other, *_ = variants
    runtime_map = ARTIFACTS / ".runtime" / "dev.json"
    dsn = json.loads(runtime_map.read_text(encoding="utf-8"))[first.key]
    with psycopg.connect(dsn, autocommit=True) as conn:
        own = relation(first.mapping, "orders", first.schema)
        remote = relation(other.mapping, "orders", other.schema)
        assert conn.execute("SHOW default_transaction_read_only").fetchone() == ("on",)
        assert conn.execute(sql.SQL("SELECT count(*) FROM {}").format(own)).fetchone() == (600,)
        assert conn.execute("SELECT to_regnamespace('hl_h01')").fetchone() == (None,)

        conn.execute("SET default_transaction_read_only = off")
        with pytest.raises(errors.InsufficientPrivilege):
            conn.execute(sql.SQL("SELECT count(*) FROM {}").format(remote))
        with pytest.raises(errors.InsufficientPrivilege):
            conn.execute(
                sql.SQL("DELETE FROM {} WHERE {} = -1").format(
                    own,
                    column(first.mapping, "orders", "id"),
                )
            )
        with pytest.raises(errors.InsufficientPrivilege):
            conn.execute("CREATE TEMP TABLE bypass (id int)")


def test_private_bundles_absent_from_online_runner():
    script = """
import importlib.util
import os
from pathlib import Path

assert importlib.util.find_spec("benchmarks") is None
assert not Path("/workspace/.artifacts").exists()
assert not Path("/workspace/benchmarks").exists()
assert not any("HOLDOUT" in key or "SEED_DSN" in key for key in os.environ)
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
        cwd=ROOT,
        check=True,
        timeout=15,
    )
