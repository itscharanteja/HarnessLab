from copy import deepcopy
from dataclasses import dataclass
from time import monotonic
from typing import Literal, TypedDict

from harnesslab_contracts.checkpoint import Checkpoint
from harnesslab_contracts.internal import private_data
from harnesslab_contracts.replay import digest
from harnesslab_contracts.validate import accepts
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langsmith import tracing_context

SCHEMA_GUIDANCE = "Retry transient SQL errors once after inspecting the error."
ZERO_USAGE = {"input_tokens": 0, "output_tokens": 0, "request_id": None}


def fixture_suggestions(request):
    variants = {
        "schema_before_discovery": (
            "/workflow/schema_inspection",
            "before_first_sql",
            "invalid_sql_rate",
            "decrease",
            "Inspect tables before sending the initial query.",
        ),
        "unrecovered_fault": (
            "/prompt/task_guidance",
            SCHEMA_GUIDANCE,
            "recovery_rate",
            "increase",
            "Recover once from a transient SQL failure.",
        ),
        "evidence_gap": (
            "/workflow/verify_numeric_answers",
            True,
            "success_rate",
            "increase",
            "Verify numeric findings against delivered evidence.",
        ),
        "blocked_repeat": (
            "/workflow/retry_policy",
            "none",
            "invalid_sql_rate",
            "decrease",
            "Stop repeating failed calls.",
        ),
        "excess_efficiency_calls": (
            "/limits/max_tool_calls",
            6,
            "tool_calls_per_success",
            "decrease",
            "Bound investigation overhead for efficient tasks.",
        ),
    }
    proposals = []
    for cluster in request["diagnosis"]["clusters"]:
        path, value, metric, direction, rationale = variants[cluster["signature"]]
        _, section, key = path.split("/")
        if request["parent"][section][key] == value:
            continue
        proposals.append(
            {
                "patch": [{"op": "replace", "path": path, "value": value}],
                "expected_metric": metric,
                "direction": direction,
                "rationale": rationale,
                "evidence_refs": cluster["evidence_refs"],
            }
        )
    return proposals[:2], ZERO_USAGE


def audit(request, suggestions):
    allowed = {
        (ref["run_id"], ref["seq"])
        for cluster in request["diagnosis"]["clusters"]
        for ref in cluster["evidence_refs"]
    }
    dispositions = []
    seen = set()
    if not isinstance(suggestions, list) or len(suggestions) > (
        2 if request["mode"] == "fixture" else 3
    ):
        suggestions = [None]
    for ordinal, proposal in enumerate(suggestions):
        reason = None
        candidate = deepcopy(request["parent"])
        if not accepts("Proposal", proposal) or private_data(proposal):
            reason = "malformed_proposal"
        elif any((ref["run_id"], ref["seq"]) not in allowed for ref in proposal["evidence_refs"]):
            reason = "invalid_evidence_lineage"
        else:
            paths = set()
            for operation in proposal["patch"]:
                path = operation["path"]
                _, section, key = path.split("/")
                value = operation["value"]
                if path in paths or candidate[section][key] == value:
                    reason = "invalid_replacement"
                    break
                paths.add(path)
                candidate[section][key] = value
            if not accepts("MutableHarness", candidate):
                reason = "invalid_candidate"
        fingerprint = None if reason else digest(candidate)
        if fingerprint in seen:
            reason = "duplicate_candidate"
        if not reason:
            seen.add(fingerprint)
        dispositions.append(
            {
                "ordinal": ordinal,
                "proposal": proposal if reason is None else None,
                "reason": reason,
                "candidate_view_digest": fingerprint if reason is None else None,
            }
        )
    return dispositions


class OptimizerState(TypedDict):
    version: Literal[1]
    request: dict
    suggestions: object
    usage: dict
    dispositions: list[dict]
    events: list[dict]
    restored: bool


@dataclass(frozen=True)
class Context:
    suggest: object
    checkpoint: Checkpoint | None
    started: float


def event(state, ctx, node):
    prior = state["events"][-1]["node_id"] if state["events"] else "start"
    return [
        *state["events"],
        {
            "seq": len(state["events"]),
            "node_id": node,
            "edge_id": f"{prior}_to_{node}",
            "outcome_code": "ok",
            "elapsed_ms": int((monotonic() - ctx.started) * 1000),
            "evidence_seq": None,
        },
    ]


async def suggest(state: OptimizerState, runtime: Runtime[Context]):
    candidates, usage = await runtime.context.suggest(state["request"])
    return {
        "suggestions": candidates,
        "usage": usage,
        "events": event(state, runtime.context, "suggest"),
    }


async def validate(state: OptimizerState, runtime: Runtime[Context]):
    updates = {
        "dispositions": audit(state["request"], state["suggestions"]),
        "events": event(state, runtime.context, "validate"),
    }
    if runtime.context.checkpoint:
        await runtime.context.checkpoint.write_bounded(
            "optimizer_validated",
            {
                "request_digest": digest(state["request"]),
                **updates,
                "usage": state["usage"],
            },
        )
    return updates


def finish(state: OptimizerState, runtime: Runtime[Context]):
    events = event(state, runtime.context, "finish")
    # A replacement lease may restart the monotonic clock after the validated boundary.
    if len(events) > 1:
        events[-1]["elapsed_ms"] = max(events[-1]["elapsed_ms"], events[-2]["elapsed_ms"])
    return {"events": events, "suggestions": None}


async def optimize(request, proposer=None, checkpoint=None):
    if not accepts("OptimizeRequest", request) or private_data(request):
        raise ValueError("invalid_optimizer_input")

    async def fixture(payload):
        return fixture_suggestions(payload)

    saved = await checkpoint.exchange("optimizer_validated") if checkpoint else None
    if saved and saved["request_digest"] != digest(request):
        raise ValueError("checkpoint_input_mismatch")
    builder = StateGraph(OptimizerState, context_schema=Context)
    builder.add_node("suggest", suggest)
    builder.add_node("validate", validate)
    builder.add_node("finish", finish)
    builder.add_conditional_edges(
        START, lambda state: "finish" if state["restored"] else "suggest", ["finish", "suggest"]
    )
    builder.add_edge("suggest", "validate")
    builder.add_edge("validate", "finish")
    builder.add_edge("finish", END)
    graph = builder.compile()
    with tracing_context(enabled=False):
        state = await graph.ainvoke(
            {
                "version": 1,
                "request": request,
                "suggestions": None,
                "usage": saved["usage"] if saved else ZERO_USAGE,
                "dispositions": saved["dispositions"] if saved else [],
                "events": saved["events"] if saved else [],
                "restored": bool(saved),
            },
            context=Context(proposer or fixture, checkpoint, monotonic()),
        )
    response = {
        "schema_version": 1,
        "dispositions": state["dispositions"],
        "usage": state["usage"],
        "graph": {
            "schema_version": 1,
            "graph_kind": "optimizer",
            "graph_version": "optimizer_v1",
            "events": state["events"],
        },
    }
    if not accepts("OptimizeResponse", response):
        raise ValueError("invalid_optimizer_result")
    return response
