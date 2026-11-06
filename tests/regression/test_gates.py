from copy import deepcopy
from uuid import UUID

from harnesslab_contracts.replay import digest
from harnesslab_eval.comparison import CATEGORIES, compare


def example():
    cells = []
    for category, count in CATEGORIES.items():
        for task in range(count):
            for repeat in range(1, 4):
                run = {
                    "trace_digest": "0" * 64,
                    "complete": True,
                    "success": True,
                    "latency_ms": 100,
                    "tool_calls": 3,
                    "worker_cost_microusd": 100,
                    "invalid_sql_attempts": 0,
                    "sql_attempts": 2,
                    "recovered": category == "tool_failures",
                    "safety_violations": 0,
                }
                ordinal = 2 * len(cells)
                cells.append(
                    {
                        "task_key": f"benchmark/validation/v{task % 3}/{category}/{task}",
                        "category": category,
                        "repeat": repeat,
                        "recoverable_fault": category == "tool_failures",
                        "baseline": {
                            **run,
                            "run_id": str(UUID(int=ordinal, version=4)),
                            "success": repeat != 1,
                            "recovered": run["recovered"] and repeat != 1,
                        },
                        "candidate": {**run, "run_id": str(UUID(int=ordinal + 1, version=4))},
                    }
                )
    return {
        "schema_version": 1,
        "experiment_id": str(UUID(int=0, version=4)),
        "baseline_hash": "1" * 64,
        "candidate_hash": "2" * 64,
        "scope": "validation",
        "mode": "live",
        "manifest_digest": "3" * 64,
        "roster_digest": "4" * 64,
        "provenance_valid": True,
        "candidate_dev_safe": True,
        "seed": 20251106,
        "cells": cells,
    }


def statuses(report):
    return {gate["gate"]: gate["status"] for gate in report["gates"]}


def test_qualifying_report_is_paired_deterministic_and_counts_all_attempts():
    request = example()
    first = compare(request)
    second = compare({**request, "cells": list(reversed(request["cells"]))})
    assert first["uncertainty"] == second["uncertainty"]
    assert first["complete"]
    assert statuses(first) == {
        "provenance": "passed",
        "safety": "passed",
        "regressions": "passed",
        "quality": "passed",
        "efficiency": "passed",
    }
    assert first["paired"] == {
        "wins": 30,
        "losses": 0,
        "ties": 60,
        "success_delta": "0.333333333333",
        "cost_reduction": "0.333333333333",
    }
    assert first["baseline"]["tool_calls_per_success"] == "4.500000000000"
    assert first["baseline"]["mean_calls_successful"] == "3.000000000000"
    assert first["baseline"]["scheduled_recoverable_faults"] == 15
    assert first["baseline"]["recovered_faults"] == 10
    assert first["candidate"]["p95_ms"] == 100
    assert first["uncertainty"]["success_delta_lower"] == "0.333333333333"
    assert len(first["uncertainty"]["leave_one_variant_out"]) == 3
    assert first["report_digest"] == digest(
        {k: v for k, v in first.items() if k != "report_digest"}
    )


def test_worse_unsafe_and_incomplete_candidates_fail_closed():
    request = example()
    for cell in request["cells"]:
        cell["candidate"].update(
            success=False, latency_ms=200, recovered=False, safety_violations=1
        )
    report = compare(request)
    assert statuses(report)["safety"] == "failed"
    assert statuses(report)["regressions"] == "failed"
    assert statuses(report)["quality"] == "unavailable"
    request["cells"][0]["candidate"] = None
    report = compare(request)
    assert not report["complete"]
    assert report["candidate"]["success_rate"] is None
    assert statuses(report)["provenance"] == "failed"


def test_protected_task_loss_and_undefined_resample_block_routes():
    request = example()
    for cell in request["cells"]:
        if cell["task_key"].endswith("/ambiguous_requests/0"):
            cell["candidate"]["success"] = False
    assert statuses(compare(request))["regressions"] == "failed"
    sparse = deepcopy(request)
    for i, cell in enumerate(sparse["cells"]):
        cell["baseline"].update(success=i == 0, recovered=False)
    report = compare(sparse)
    assert report["paired"]["cost_reduction"] is not None
    assert report["uncertainty"]["cost_reduction_95"] is None
    assert report["uncertainty"]["cost_reduction_lower"] is None
    assert statuses(report)["efficiency"] == "unavailable"


def test_fixture_report_is_ineligible_even_with_qualifying_metrics():
    report = compare({**example(), "mode": "fixture"})
    assert report["complete"]
    assert report["gates"] == [
        {"gate": "provenance", "status": "failed", "reason": "ineligible_fixture"}
    ]
