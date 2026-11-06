import asyncio
from copy import deepcopy
from uuid import UUID

import pytest
from harnesslab_eval.analysis import analyze_dev
from harnesslab_opt.graph import ZERO_USAGE, fixture_suggestions, optimize

SCHEMA = {
    "seq": 1,
    "kind": "tool_result",
    "code": "missing_relation",
    "tool": "execute_readonly_sql",
}
FAULT = {"seq": 2, "kind": "fault", "code": "timeout", "tool": "execute_readonly_sql"}


def row(index, category, event, success=False, calls=1, reasons=()):
    return {
        "run_id": str(UUID(int=index, version=4)),
        "success": success,
        "tool_calls": calls,
        "task_key": f"synthetic-business-v1/dev/d01/{category}/{index:02d}",
        "cost_micros": 0,
        "reasons": list(reasons),
        "events": [event],
    }


@pytest.fixture
def proposal_request(harness):
    parent = {key: deepcopy(harness[key]) for key in ("prompt", "workflow", "context", "limits")}
    parent["limits"] = {k: parent["limits"][k] for k in ("max_tool_calls", "max_retries_per_tool")}
    runs = [
        row(1, "schema_discovery", SCHEMA),
        row(2, "schema_discovery", SCHEMA),
        row(3, "tool_failures", FAULT),
        row(4, "tool_failures", FAULT),
        row(5, "efficiency", SCHEMA, success=True),
    ]
    return {
        "schema_version": 1,
        "mode": "fixture",
        "model": None,
        "parent": parent,
        "diagnosis": analyze_dev(runs),
    }, runs


def test_recurring_trace_evidence_controls_fixture_proposals(proposal_request):
    request, runs = proposal_request
    first = asyncio.run(optimize(request))
    entries = first["dispositions"]
    assert len(entries) == 2 and all(item["reason"] is None for item in entries)
    assert len({item["candidate_view_digest"] for item in entries}) == 2
    assert first["usage"] == ZERO_USAGE
    remaining = [item for item in runs if item["task_key"].split("/")[3] != "schema_discovery"]
    second = asyncio.run(optimize({**request, "diagnosis": analyze_dev(remaining)}))
    assert len(second["dispositions"]) == 1
    assert second["dispositions"][0]["proposal"]["expected_metric"] == "recovery_rate"
    assert analyze_dev(list(reversed(runs))) == request["diagnosis"]


def test_optimizer_rejects_malformed_patch_and_cross_sample_evidence(proposal_request):
    request, _ = proposal_request
    valid, _ = fixture_suggestions(request)
    malformed, cross_sample = deepcopy(valid)
    malformed["patch"][0]["path"] = "/limits/max_model_turns"
    cross_sample["evidence_refs"][0]["run_id"] = str(UUID(int=72, version=4))

    async def scripted(_):
        return [malformed, cross_sample], ZERO_USAGE

    response = asyncio.run(optimize(request, proposer=scripted))
    assert [entry["reason"] for entry in response["dispositions"]] == [
        "malformed_proposal",
        "invalid_evidence_lineage",
    ]
    assert all(entry["proposal"] is None for entry in response["dispositions"])


def test_analysis_refuses_validation_and_duplicate_task(proposal_request):
    _, runs = proposal_request
    with pytest.raises(ValueError, match="invalid diagnosis sample"):
        analyze_dev([runs[0], runs[0] | {"run_id": runs[1]["run_id"]}])
    with pytest.raises(ValueError, match="invalid diagnosis sample"):
        analyze_dev([runs[0] | {"task_key": runs[0]["task_key"].replace("/dev/", "/validation/")}])
