import asyncio
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import pytest
from harnesslab_contracts.replay import digest
from harnesslab_runner.fixture import fixture_request
from harnesslab_runner.graph import validate_request

from scripts.holdout_job import evaluate_run, failed, open_ledger, seal_evaluation


def test_online_images_have_no_operator_job_or_holdout_credentials():
    compose = ["docker", "compose", "--file", "infra/docker/compose.yaml"]
    for service in ("api", "dispatcher", "runner", "evaluator", "optimizer"):
        subprocess.run(
            [
                *compose,
                "exec",
                "-T",
                service,
                "sh",
                "-ec",
                "test ! -e /workspace/holdout_job.py "
                "&& test ! -e /workspace/scripts/holdout_job.py "
                '&& test ! -e /fixture/holdout && test -z "${HL_HOLDOUT_API_KEY:-}" '
                '&& test -z "${HL_HOLDOUT_SANDBOX_DATABASE:-}" '
                '&& test -z "${HL_SANDBOX_HOLDOUT_RUNTIME_MAP_FILE:-}"',
            ],
            check=True,
            capture_output=True,
            timeout=10,
        )


def test_online_boundaries_refuse_holdout_before_accessing_artifacts(harness, dispatcher_node):
    root = Path(".artifacts/benchmark-fixture/holdout")
    entry = json.loads((root / "prompts.json").read_bytes())[0]
    manifest = json.loads((root / "manifest.json").read_bytes())
    request = fixture_request(entry["task"], harness, manifest, entry["fault"])
    request["manifest"]["stage"] = "validate"
    validate_request(request, operator_holdout=True)
    with pytest.raises(ValueError, match="provenance"):
        validate_request(request)
    result = dispatcher_node(
        """
        const {runner,compare}=JSON.parse(await new Response(process.stdin).text());
        const post=async (base,path,token,body)=>{
          const response=await fetch(new URL(path,base),{
            method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},
            body:JSON.stringify(body)
          });
          return response.status;
        };
        const status=await Promise.all([
          post(process.env.RUNNER_URL,"/internal/v1/execute-task",process.env.HL_RUNNER_TOKEN,runner),
          post(process.env.EVALUATOR_URL,"/internal/v1/compare",process.env.HL_EVALUATOR_TOKEN,compare)
        ]);
        console.log(JSON.stringify(status));
        """,
        payload={
            "runner": request,
            "compare": {
                "schema_version": 1,
                "experiment_id": str(uuid4()),
                "baseline_hash": "1" * 64,
                "candidate_hash": "2" * 64,
                "scope": "holdout",
                "mode": "fixture",
                "manifest_digest": "3" * 64,
                "roster_digest": "4" * 64,
                "provenance_valid": True,
                "candidate_dev_safe": False,
                "seed": 0,
                "cells": [],
            },
        },
    )
    assert result == [422, 422]


def test_sealed_holdout_rejects_a_different_pair_and_never_replays_ambiguous_paid_work(tmp_path):
    db = open_ledger(tmp_path)
    pin = {
        "manifest_digest": digest("test"),
        "baseline": "a",
        "candidate": "b",
        "mode": "live",
        "price": {"input": "1000000", "output": "1000000"},
    }
    try:
        assert seal_evaluation(db, pin["manifest_digest"], pin) is None
        with pytest.raises(ValueError, match="holdout_already_sealed"):
            seal_evaluation(db, pin["manifest_digest"], {**pin, "candidate": "c"})
        run_id = str(uuid4())
        with db:
            db.execute(
                "INSERT INTO runs(digest,run_id,state,deadline) VALUES(?,?,'running','old')",
                (pin["manifest_digest"], run_id),
            )
        request = {"manifest": {"run_id": run_id}}
        result = asyncio.run(evaluate_run(db, pin, request, None, None, None))
        assert result == failed(run_id, 15000)
        assert asyncio.run(evaluate_run(db, pin, request, None, None, None)) == result
        assert db.execute("SELECT state,charged FROM runs").fetchone() == ("done", 15000)
    finally:
        db.close()
