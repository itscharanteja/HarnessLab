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


@pytest.fixture
def control_dsn():
    import os

    from psycopg.conninfo import conninfo_to_dict

    dsn = os.environ.get(
        "CONTROL_DISPATCHER_DSN",
        "postgresql://hl_dispatcher:fixture_dispatcher@127.0.0.1:55432/harnesslab_control",
    )
    if conninfo_to_dict(dsn).get("host") not in {"localhost", "127.0.0.1"}:
        pytest.fail("Control delivery tests require a local fixture database")
    return dsn


@pytest.fixture
def dispatcher_node():
    import subprocess

    def run(script, *args, payload=None):
        output = subprocess.run(
            [
                "docker",
                "compose",
                "--file",
                "infra/docker/compose.yaml",
                "exec",
                "-T",
                "-w",
                "/workspace/apps/dispatcher",
                "dispatcher",
                "node",
                "--input-type=module",
                "-e",
                script,
                *args,
            ],
            input=json.dumps(payload),
            text=True,
            check=True,
            capture_output=True,
            timeout=35,
        )
        return json.loads(output.stdout)

    return run


@pytest.fixture
def work_case(control_dsn, benchmark_request):
    from uuid import uuid4

    import psycopg
    from harnesslab_contracts.replay import digest
    from psycopg.types.json import Jsonb

    def create(mode="fixture", expected=1, cap=50000):
        request = benchmark_request()
        manifest = {**request["manifest"], "mode": mode, "evaluator_version": "phase3-eval-v1"}
        task = request["task"]
        price = (
            {"input": "1000000", "output": "1000000"}
            if mode == "live"
            else {"input": "0", "output": "0"}
        )
        manifest["price_profile_digest"] = digest(price)
        exp_id, work_id = uuid4(), uuid4()
        with psycopg.connect(control_dsn) as db:
            baseline, revision = db.execute(
                "SELECT active_version_id,revision FROM hl.harness_channels WHERE channel='fixture'"
            ).fetchone()
            db.execute(
                """INSERT INTO hl.benchmark_tasks(benchmark_digest,task_key,split,category,
                   dataset_digest,variant_id,input_hash) VALUES (%s,%s,'dev',%s,%s,%s,%s)
                   ON CONFLICT DO NOTHING""",
                (
                    manifest["benchmark_digest"],
                    task["task_key"],
                    task["category"],
                    manifest["dataset_digest"],
                    task["variant_id"],
                    manifest["task_input_hash"],
                ),
            )
            db.execute(
                """INSERT INTO hl.experiments(id,baseline_id,channel,channel_revision,principal,
                    idempotency_key,request_hash,mode,scope,max_spend_micros,manifest)
                   VALUES (%s,%s,'fixture',%s,'phase3-test',%s,%s,%s,%s,%s,%s)""",
                (
                    exp_id,
                    baseline,
                    revision,
                    str(exp_id),
                    "0" * 64,
                    mode,
                    "full_live" if mode == "live" else "demo_fixture",
                    cap,
                    Jsonb({"schema_version": 1, "expected_runs": expected, "price": price}),
                ),
            )
            db.execute(
                """INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
                   VALUES (%s,%s,'baseline',0,'scheduled')""",
                (exp_id, baseline),
            )
            db.execute(
                """INSERT INTO hl.task_runs(id,experiment_id,harness_id,benchmark_digest,task_key,
                   stage,repeat,manifest) VALUES (%s,%s,%s,%s,%s,'diagnose',1,%s)""",
                (
                    manifest["run_id"],
                    exp_id,
                    baseline,
                    manifest["benchmark_digest"],
                    task["task_key"],
                    Jsonb(manifest),
                ),
            )
            db.execute(
                """INSERT INTO hl.work_items(id,experiment_id,work_key,kind,run_id,
                    graph_version,input_digest)
                   VALUES (%s,%s,%s,'execute_task',%s,'worker_v1',%s)""",
                (
                    work_id,
                    exp_id,
                    f"task/{manifest['run_id']}",
                    manifest["run_id"],
                    digest(manifest),
                ),
            )
            # A future unsent row prevents the real relay racing the test claim.
            db.execute(
                """INSERT INTO hl.outbox(work_id,generation,available_at)
                   VALUES (%s,1,clock_timestamp()+interval '1 day')""",
                (work_id,),
            )
        return {"experiment": str(exp_id), "work_id": str(work_id), "run_id": manifest["run_id"]}

    return create
