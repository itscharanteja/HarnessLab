#!/usr/bin/env python3
"""Run a live DataOps investigation using AWS Bedrock Claude Sonnet 4.5 and commit it to the Control DB for Dashboard viewing."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
from harnesslab_contracts.internal import read_json
from harnesslab_contracts.replay import digest
from harnesslab_eval.grader import grade_run
from harnesslab_runner.config import digest as config_digest, read_harness
from harnesslab_runner.graph import execute
from harnesslab_runner.model import BedrockConverseTurns

CONTROL_DSN = "postgresql://hl_control_admin:fixture_control_admin@127.0.0.1:55432/harnesslab_control"
RUNTIME_MAP_FILE = Path(".artifacts/benchmark-fixture/.runtime/dev.json")
BASELINE_FILE = Path("harnesses/baseline.yaml")
CATALOG_FILE = Path("datasets/synthetic-business/metrics.json").resolve()
PROFILE_FILE = Path("harnesses/profiles/worker-bedrock-sonnet-4-5.json")
PRICE_FILE = Path("harnesses/profiles/pricing-bedrock-sonnet-4-5.json")
PROMPTS_FILE = Path("benchmarks/development/prompts.json")
MANIFEST_FILE = Path("benchmarks/development/manifest.json")
ORACLES_FILE = Path("benchmarks/development/oracles.json")


async def main():
    print("=================================================================")
    print("  HarnessLab Live Bedrock Investigation with Claude Sonnet 4.5")
    print("=================================================================")

    # 1. Load profiles and task data
    worker_settings = read_json(PROFILE_FILE)
    price_profile = read_json(PRICE_FILE)
    runtime_map = read_json(RUNTIME_MAP_FILE)
    prompts = read_json(PROMPTS_FILE)
    manifest = read_json(MANIFEST_FILE)
    oracles = read_json(ORACLES_FILE)

    task = prompts[0]
    task_key = task["task_key"]
    variant_id = task["variant_id"]
    oracle = next(o for o in oracles if o["task_key"] == task_key)
    variant_dsn = runtime_map[variant_id]

    harness = read_harness(BASELINE_FILE.read_bytes()).config
    cfg_hash = config_digest(harness)

    run_id = str(uuid.uuid4())
    exp_id = str(uuid.uuid4())

    meta = next(t for t in manifest["tasks"] if t["id"] == task_key)
    variant_meta = next(v for v in manifest["variants"] if v["id"] == variant_id)

    print(f"Task Key   : {task_key}")
    print(f"Prompt     : {task['prompt']}")
    print(f"Variant    : {variant_id}")
    print(f"Model      : {worker_settings['snapshot']}")
    print(f"Experiment : {exp_id}")
    print("-----------------------------------------------------------------")

    # 2. Build execution request
    request = {
        "schema_version": 1,
        "task": task,
        "harness": harness,
        "deadline": (datetime.now(UTC) + timedelta(seconds=90)).isoformat().replace("+00:00", "Z"),
        "manifest": {
            "schema_version": 1,
            "run_id": run_id,
            "mode": "live",
            "stage": "diagnose",
            "task_key": task_key,
            "repeat": 1,
            "task_input_hash": meta["input_hash"],
            "config_hash": cfg_hash,
            "dataset_digest": variant_meta["rows_digest"],
            "benchmark_digest": manifest["manifest_digest"],
            "software_revision": "phase2-live-bedrock",
            "evaluator_version": "phase3-eval-v1",
            "safety_profile": harness["safety_profile"],
            "worker": worker_settings,
            "worker_profile_digest": digest(worker_settings),
            "price_profile_digest": digest(price_profile["worker"]),
            "schedule_seed": 20251106,
        },
    }

    # 3. Execute Worker Graph live with Claude Sonnet 4.5
    print("\nExecuting Worker Graph with Claude Sonnet 4.5 on AWS Bedrock...")
    model = BedrockConverseTurns(worker_settings)
    events = []
    run = await execute(request, model, variant_dsn, CATALOG_FILE, graph_events=events)

    print(f"Execution complete! Result status: {run['result']}")
    print(f"Total events: {len(run['events'])}")

    # 4. Deterministic Evaluation
    grade_result = grade_run(run, oracle)
    grade = grade_result["grade"]
    replay_digest = grade_result["replay_digest"]
    print(f"Evaluation Grade : {'SUCCESS' if grade['success'] else 'FAILED'}")
    if not grade["success"]:
        print(f"Reasons          : {grade['reasons']}")

    # Calculate token & cost metrics
    input_tokens = sum(
        e["payload"]["input_tokens"] for e in run["events"] if e["kind"] == "model_usage"
    )
    output_tokens = sum(
        e["payload"]["output_tokens"] for e in run["events"] if e["kind"] == "model_usage"
    )
    inp_price = int(price_profile["worker"]["input"])
    out_price = int(price_profile["worker"]["output"])
    cost_micros = (input_tokens * inp_price + output_tokens * out_price + 999999) // 1000000
    tool_calls = sum(1 for e in run["events"] if e["kind"] == "tool_request")
    safety_count = sum(
        1
        for e in run["events"]
        if e["kind"] == "policy_decision" and e["payload"].get("safety_violation")
    )
    latency_ms = max(e["elapsed_ms"] for e in run["events"]) if run["events"] else 0

    print(f"Input Tokens     : {input_tokens}")
    print(f"Output Tokens    : {output_tokens}")
    print(f"Tool Calls       : {tool_calls}")
    print(f"Cost             : ${cost_micros / 1_000_000:.6f} ({cost_micros} micro-USD)")

    # 5. Commit to Control DB
    print("\nCommitting run and trace events to Control Database...")
    with psycopg.connect(CONTROL_DSN) as conn:
        with conn.cursor() as cur:
            # Baseline version
            cur.execute(
                "SELECT id FROM hl.harness_versions WHERE content_sha256 = %s", [cfg_hash]
            )
            row = cur.fetchone()
            if not row:
                cur.execute(
                    """
                    INSERT INTO hl.harness_versions(content_sha256, config, canonical_json, yaml_bytes)
                    VALUES(%s, %s, %s, %s) RETURNING id
                    """,
                    [cfg_hash, json.dumps(harness), json.dumps(harness).encode(), BASELINE_FILE.read_bytes()],
                )
                harness_id = cur.fetchone()[0]
            else:
                harness_id = row[0]

            # Ensure channel exists
            cur.execute(
                """
                INSERT INTO hl.harness_channels(channel, active_version_id, revision)
                VALUES('production', %s, 1)
                ON CONFLICT (channel) DO UPDATE SET active_version_id = EXCLUDED.active_version_id
                """,
                [harness_id],
            )

            # Ensure task exists in benchmark_tasks
            cur.execute(
                """
                INSERT INTO hl.benchmark_tasks(benchmark_digest, task_key, split, category, dataset_digest, variant_id, input_hash)
                VALUES(%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (benchmark_digest, task_key) DO NOTHING
                """,
                [
                    manifest["manifest_digest"],
                    task_key,
                    task["split"],
                    task["category"],
                    variant_meta["rows_digest"],
                    variant_id,
                    meta["input_hash"],
                ],
            )

            # Create experiment
            exp_manifest = {
                "schema_version": 1,
                "scope": "full_live",
                "mode": "live",
                "worker": worker_settings,
                "price": price_profile["worker"],
            }
            cur.execute(
                """
                INSERT INTO hl.experiments(
                    id, baseline_id, channel, channel_revision, principal, idempotency_key,
                    request_hash, mode, scope, status, stage, manifest, max_spend_micros,
                    spent_micros, completed_at
                )
                VALUES(
                    %s, %s, 'production', 1, %s, %s, %s, 'live', 'full_live', 'completed',
                    'diagnose', %s, 5000000, %s, clock_timestamp()
                )
                """,
                [
                    exp_id,
                    harness_id,
                    "operator:00000000-0000-4000-8000-000000000001",
                    f"live-bedrock-{uuid.uuid4().hex[:12]}",
                    digest(exp_manifest),
                    json.dumps(exp_manifest),
                    cost_micros,
                ],
            )

            # Create experiment arm
            cur.execute(
                """
                INSERT INTO hl.experiment_arms(experiment_id, harness_id, role, ordinal, disposition)
                VALUES(%s, %s, 'baseline', 0, 'active')
                """,
                [exp_id, harness_id],
            )

            # Insert task run
            cur.execute(
                """
                INSERT INTO hl.task_runs(
                    id, experiment_id, harness_id, benchmark_digest, task_key, stage, repeat,
                    manifest, result_status, envelope, answer, grade, replay_digest, trace_digest,
                    latency_ms, input_tokens, output_tokens, tool_calls, safety_count, cost_micros,
                    completed_at
                )
                VALUES(
                    %s, %s, %s, %s, %s, 'diagnose', 1, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, clock_timestamp()
                )
                """,
                [
                    run_id,
                    exp_id,
                    harness_id,
                    manifest["manifest_digest"],
                    task_key,
                    json.dumps(run["manifest"]),
                    run["result"],
                    json.dumps(run),
                    json.dumps(run["answer"]) if run["answer"] else None,
                    json.dumps(grade),
                    replay_digest,
                    run["trace_digest"],
                    latency_ms,
                    input_tokens,
                    output_tokens,
                    tool_calls,
                    safety_count,
                    cost_micros,
                ],
            )

            # Insert trace events
            for event in run["events"]:
                cur.execute(
                    """
                    INSERT INTO hl.trace_events(
                        run_id, seq, kind, outcome_code, elapsed_ms, correlation_id, payload
                    )
                    VALUES(%s, %s, %s, %s, %s, %s, %s)
                    """,
                    [
                        run_id,
                        event["seq"],
                        event["kind"],
                        event["outcome_code"],
                        event["elapsed_ms"],
                        event.get("correlation_id"),
                        json.dumps(event["payload"]),
                    ],
                )

        conn.commit()

    print("\n=================================================================")
    print("  LIVE RUN COMMITTED SUCCESSFULLY!")
    print("=================================================================")
    print(f"View live on Dashboard : http://localhost:3000/experiments/{exp_id}")
    print("=================================================================")


if __name__ == "__main__":
    asyncio.run(main())
