from copy import deepcopy
from pathlib import Path

import pytest
from harnesslab_contracts.replay import digest, trace_digest
from harnesslab_eval.artifacts import reference_for
from harnesslab_eval.grader import grade_run, render_answer

ARTIFACTS = Path(".artifacts/benchmark-fixture")


def event(run, kind, code, payload, correlation=None):
    return {
        "run_id": run["manifest"]["run_id"],
        "seq": len(run["events"]),
        "elapsed_ms": 0,
        "kind": kind,
        "outcome_code": code,
        "correlation_id": correlation,
        "payload": payload,
    }


def add(run, kind, code, payload, correlation=None):
    run["events"].append(event(run, kind, code, payload, correlation))


def empty(manifest):
    run = {
        "schema_version": 1,
        "manifest": manifest,
        "answer": None,
        "result": "unable",
        "events": [],
    }
    add(
        run,
        "start",
        "started",
        {
            "task_key": manifest["task_key"],
            "config_hash": manifest["config_hash"],
        },
    )
    return run


def result(run, answer):
    run["answer"] = answer
    run["result"] = {"answer": "answered", "clarify": "clarified", "unable": "unable"}[
        answer["kind"]
    ]
    add(run, "final_output", run["result"], answer)
    run["trace_digest"] = trace_digest(run["events"])
    return run


def sql_evidence(run, count, alias="order_count"):
    call = {
        "kind": "tool",
        "name": "execute_readonly_sql",
        "arguments": {"sql": "SELECT count(*) FROM orders"},
    }
    add(run, "tool_request", "requested", {"call": call, "origin": "model"}, "call_1")
    payload = {"columns": [{"name": alias, "type": "integer"}], "rows": [[count]]}
    add(
        run,
        "tool_result",
        "ok",
        {
            "status": "ok",
            "name": call["name"],
            "data": {
                **payload,
                "payload_hash": digest(payload),
                "query_id": "query_1",
            },
        },
        "call_1",
    )
    return {"kind": "cell", "query_id": "query_1", "column": alias, "row": 0}


def test_replay_phase2_envelope_has_same_grade_and_digest(benchmark_request):
    manifest = benchmark_request()["manifest"]
    run = empty(manifest)
    add(run, "model_usage", "ok", {"input_tokens": 5, "output_tokens": 12, "request_id": "old"})
    cell = sql_evidence(run, 6)
    result(
        run,
        {
            "kind": "answer",
            "findings": [
                {"key": "order_count", "value": 6, "unit": "count", "evidence": [cell]},
            ],
        },
    )
    oracle = reference_for(run, ARTIFACTS)
    graded = grade_run(run, oracle)
    assert graded["grade"] == {"schema_version": 1, "success": True, "reasons": []}
    replay = deepcopy(run)
    for item in replay["events"]:
        item["elapsed_ms"] = item["seq"] * 5
    replay["events"][1]["payload"]["request_id"] = "new"
    replay["events"][1]["payload"]["input_tokens"] = 123
    assert grade_run(replay, oracle) == graded
    assert "query_1 row 0 column order_count" in render_answer(run["answer"], {})


@pytest.mark.parametrize(("reported", "expected"), [(6, True), (7, False)])
def test_recomputes_calculation_from_recorded_operands(benchmark_request, reported, expected):
    run = empty(benchmark_request()["manifest"])
    cell = sql_evidence(run, 6)
    operand = {"source": cell, "unit": "count"}
    add(
        run,
        "tool_request",
        "requested",
        {
            "origin": "model",
            "call": {
                "kind": "tool",
                "name": "validate_calculation",
                "arguments": {"operation": "identity", "operands": [operand]},
            },
        },
        "call_2",
    )
    add(
        run,
        "tool_result",
        "ok",
        {
            "status": "ok",
            "name": "validate_calculation",
            "data": {
                "calculation_id": "calculation_1",
                "value": str(reported),
                "unit": "count",
                "sources": [operand],
            },
        },
        "call_2",
    )
    result(
        run,
        {
            "kind": "answer",
            "findings": [
                {
                    "key": "order_count",
                    "value": 6,
                    "unit": "count",
                    "evidence": [
                        {"kind": "calculation", "calculation_id": "calculation_1"},
                    ],
                },
            ],
        },
    )
    grade = grade_run(run, reference_for(run, ARTIFACTS))["grade"]
    assert grade["success"] is expected
    assert ("unsupported_evidence" in grade["reasons"]) is not expected


@pytest.mark.parametrize("attempt", [False, True])
def test_clarification_requires_exact_fields_and_no_sql(benchmark_request, attempt):
    run = empty(benchmark_request("ambiguous_requests")["manifest"])
    if attempt:
        sql_evidence(run, 6)
    result(run, {"kind": "clarify", "missing_fields": ["period"], "question": "Which period?"})
    grade = grade_run(run, reference_for(run, ARTIFACTS))["grade"]
    assert grade["success"] is not attempt
    assert ("sql_before_clarification" in grade["reasons"]) is attempt


def test_mismatched_lineage_is_rejected(benchmark_request):
    run = empty(benchmark_request()["manifest"])
    result(run, {"kind": "unable", "reason": "fixture_stop"})
    oracle = reference_for(run, ARTIFACTS)
    run["events"][1]["seq"] = 4
    run["trace_digest"] = trace_digest(run["events"])
    with pytest.raises(ValueError, match="lineage"):
        grade_run(run, oracle)
