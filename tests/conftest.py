import json
from pathlib import Path

import pytest
from harnesslab_runner.fixture import BASELINE, CATALOG, fixture_request, read_harness

from benchmarks.generators.cli import fixture_variants

ARTIFACTS = Path(".artifacts/benchmark-fixture")


@pytest.fixture
def harness():
    return read_harness(BASELINE.read_bytes()).config


@pytest.fixture
def sandbox():
    def load(split="dev", variant=None):
        _, variants = fixture_variants(split)
        selected = next((item for item in variants if item.key == variant), variants[0])
        runtime_map = ARTIFACTS / ".runtime" / f"{split}.json"
        if not runtime_map.is_file():
            pytest.fail("Run make benchmark-generate benchmark-seed MODE=fixture")
        return selected, json.loads(runtime_map.read_text())[selected.key]

    return load


@pytest.fixture
def benchmark_request(harness):
    def build(category="efficiency", split="dev", config=None):
        root = ARTIFACTS / split
        manifest = json.loads((root / "manifest.json").read_text())
        entry = next(
            row
            for row in json.loads((root / "prompts.json").read_text())
            if row["task"]["category"] == category
        )
        return fixture_request(entry["task"], config or harness, manifest, entry["fault"])

    return build


@pytest.fixture
def catalog():
    return CATALOG
