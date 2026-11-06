import asyncio
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from time import monotonic
from typing import Literal, TypedDict

from harnesslab_contracts.validate import accepts
from harnesslab_mcp.server import TOOL_ARGS
from harnesslab_mcp.sql_policy import MAX_SQL_BYTES, QueryRejected, check_query
from harnesslab_mcp.tools import TRANSIENT, hint, json_bytes
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langsmith import tracing_context
from pydantic import TypeAdapter

from .config import digest, json_types
from .mcp_client import DataOpsSession, open_dataops
from .model import Model

MAX_CONTEXT_RESULT_BYTES = 1400
SECRET = re.compile(r"postgres(?:ql)?://|\bpassword\s*=|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}", re.I)
SAFETY_ERRORS = {"sql_policy", "evidence_scope"}
Result = Literal[
    "answered", "clarified", "unable", "unsafe", "budget_exhausted", "infrastructure_error"
]


class WorkerState(TypedDict):
    version: Literal[1]
    run_id: str
    deadline_utc: str
    turns: int
    calls: int
    input_tokens: int
    output_tokens: int
    events: list[dict]
    recent: list[dict]
    metadata: list[str]
    evidence: dict[str, dict]
    failures: dict[str, dict]
    retries: dict[str, int]
    failed_sql: dict[str, str]
    repeated_sql: list[str]
    fault_used: bool
    fault_error_id: str | None
    sql_attempted: bool
    correction_used: bool
    action: dict | None
    pending: dict | None
    answer: dict | None
    result: Result | None


STATE = TypeAdapter(WorkerState)


@dataclass(frozen=True)
class RunContext:
    request: dict
    model: Model
    mcp: DataOpsSession
    started: float
    deadline: float

    @property
    def config(self) -> dict:
        return self.request["harness"]


def emit(state: WorkerState, started: float, kind: str, code: str, payload: dict, correlation=None):
    event = {
        "run_id": state["run_id"],
        "seq": len(state["events"]),
        "elapsed_ms": max(0, int((monotonic() - started) * 1000)),
        "kind": kind,
        "outcome_code": code,
        "correlation_id": correlation,
        "payload": payload,
    }
    state["events"] = [*state["events"], event]


def policy(state: WorkerState, ctx: RunContext, code: str, safety=False, correlation=None):
    emit(
        state,
        ctx.started,
        "policy_decision",
        code,
        {"reason": code, "safety_violation": safety},
        correlation,
    )
    if safety:
        state["result"] = "unsafe"


def stop(state: WorkerState, ctx: RunContext, result: Result, code: str):
    policy(state, ctx, code)
    state["result"] = result


def private_data(value) -> bool:
    try:
        return bool(SECRET.search(json_bytes(value).decode()))
    except UnicodeError:
        return True


def bounded_result(result: dict) -> dict:
    if len(json_bytes(result)) <= MAX_CONTEXT_RESULT_BYTES:
        return result
    data = result["data"]
    if result["name"] == "execute_readonly_sql":
        preview = {
            "name": result["name"],
            "status": "ok",
            "preview": True,
            "query_id": data["query_id"],
            "columns": data["columns"][:8],
            "row_count": len(data["rows"]),
            "rows": [],
        }
        for row in data["rows"]:
            if len(row) != len(preview["columns"]):
                break
            candidate = {**preview, "rows": [*preview["rows"], row]}
            if len(json_bytes(candidate)) > MAX_CONTEXT_RESULT_BYTES:
                break
            preview = candidate
        return preview
    return {
        "name": result["name"],
        "status": "ok",
        "preview": True,
        "data_prefix": json_bytes(data)[:900].decode(errors="ignore"),
    }


async def model_turn(state: WorkerState, runtime: Runtime[RunContext]) -> WorkerState:
    state = state.copy()
    ctx = runtime.context
    limits = ctx.config["limits"]
    if (
        state["turns"] >= limits["max_model_turns"]
        or state["output_tokens"] >= limits["max_output_tokens"]
    ):
        stop(state, ctx, "budget_exhausted", "model_budget")
        return state

    last_policy = next(
        (
            event["outcome_code"]
            for event in reversed(state["events"])
            if event["kind"] == "policy_decision"
        ),
        None,
    )
    payload = json_bytes(
        {
            "task": ctx.request["task"],
            "task_guidance": ctx.config["prompt"]["task_guidance"],
            "verify_numeric_answers": ctx.config["workflow"]["verify_numeric_answers"],
            "known_tables": state["metadata"],
            "recent_results": state["recent"],
            "evidence_ids": sorted(state["evidence"]),
            "policy_event": last_policy,
        }
    ).decode()
    if private_data(payload):
        stop(state, ctx, "infrastructure_error", "redaction_required")
        return state
    estimate = ctx.model.estimate(payload)
    if estimate > limits["max_input_tokens"] - state["input_tokens"]:
        stop(state, ctx, "budget_exhausted", "input_budget")
        return state
    allowance = limits["max_output_tokens"] - state["output_tokens"]
    if allowance < ctx.model.minimum_output_tokens:
        stop(state, ctx, "budget_exhausted", "output_budget")
        return state
    timeout = ctx.request["manifest"]["worker"]["timeout_ms"] / 1000
    state["turns"] += 1
    try:
        async with asyncio.timeout_at(
            min(ctx.deadline, asyncio.get_running_loop().time() + timeout)
        ):
            turn = await ctx.model.turn(payload, allowance)
    except TimeoutError:
        stop(state, ctx, "infrastructure_error", "model_timeout")
        return state
    except Exception:
        stop(state, ctx, "infrastructure_error", "model_error")
        return state

    usage = {
        "input_tokens": turn.input_tokens,
        "output_tokens": turn.output_tokens,
        "request_id": turn.request_id,
    }
    if not json_types(usage) or not accepts("ModelUsage", usage) or private_data(usage):
        stop(state, ctx, "infrastructure_error", "usage_mismatch")
        return state
    state["input_tokens"] += turn.input_tokens
    state["output_tokens"] += turn.output_tokens
    emit(state, ctx.started, "model_usage", "ok", usage, f"turn_{state['turns']}")
    if state["input_tokens"] > limits["max_input_tokens"] or turn.output_tokens > allowance:
        stop(state, ctx, "budget_exhausted", "reported_budget_overrun")
        return state
    if not turn.usage_valid or turn.input_tokens > estimate:
        stop(state, ctx, "infrastructure_error", "usage_mismatch")
        return state
    raw = turn.action
    action = raw.get("action") if isinstance(raw, dict) else None
    if not json_types(raw) or not accepts("WorkerAction", raw):
        correlation = None
        if isinstance(action, dict) and action.get("kind") == "tool":
            if not consume_call(state, ctx):
                return state
            correlation = f"call_{state['calls']}"
            name = action.get("name")
            if not isinstance(name, str) or name not in TOOL_ARGS:
                policy(state, ctx, "tool_scope", safety=True, correlation=correlation)
                return state
            if name == "execute_readonly_sql":
                state["sql_attempted"] = True
        policy(state, ctx, "malformed_action", correlation=correlation)
        return state

    if private_data(raw):
        correlation = None
        if raw["action"]["kind"] == "tool":
            if not consume_call(state, ctx):
                return state
            correlation = f"call_{state['calls']}"
        policy(state, ctx, "redaction_required", correlation=correlation)
        state["result"] = "infrastructure_error"
        return state
    state["action"] = raw["action"]
    return state


def consume_call(state: WorkerState, ctx: RunContext) -> bool:
    if state["calls"] >= ctx.config["limits"]["max_tool_calls"]:
        stop(state, ctx, "budget_exhausted", "tool_budget")
        return False
    state["calls"] += 1
    return True


def begin_call(state: WorkerState, ctx: RunContext, call: dict, origin: str) -> bool:
    if not consume_call(state, ctx):
        return False
    correlation = f"call_{state['calls']}"
    state["pending"] = {"call": call, "correlation": correlation, "origin": origin}
    emit(
        state,
        ctx.started,
        "tool_request",
        "requested",
        {"call": call, "origin": origin},
        correlation,
    )
    return True


def tool_call(name: str, **arguments) -> dict:
    return {"kind": "tool", "name": name, "arguments": arguments}


def finish(state: WorkerState, ctx: RunContext, answer: dict):
    kind = answer["kind"]
    if kind == "clarify" and (
        state["sql_attempted"]
        or not set(answer["missing_fields"])
        <= set(ctx.request["task"]["allowed_clarification_fields"])
    ):
        policy(state, ctx, "invalid_clarification")
        return
    if kind == "answer":
        findings = answer["findings"]
        keys = [finding["key"] for finding in findings]
        if len(set(keys)) != len(keys):
            policy(state, ctx, "duplicate_findings")
            return
        for finding in findings:
            verified = False
            value = finding["value"]
            output = next(
                (key for key in ctx.request["task"]["output_keys"] if key["key"] == finding["key"]),
                None,
            )
            numeric = output is not None and output["value_type"] in {"integer", "decimal"}
            if output is None:
                numeric = type(value) is int or accepts("DecimalString", value)
            for ref in finding["evidence"]:
                if ref["kind"] == "cell":
                    data = state["evidence"].get(ref["query_id"])
                    if data is None or "rows" not in data:
                        policy(state, ctx, "evidence_scope", safety=True)
                        return
                    if ref["row"] >= len(data["rows"]) or ref["column"] not in {
                        col["name"] for col in data["columns"]
                    }:
                        policy(state, ctx, "invalid_evidence")
                        return
                else:
                    data = state["evidence"].get(ref["calculation_id"])
                    if data is None or "sources" not in data:
                        policy(state, ctx, "evidence_scope", safety=True)
                        return
                    if (
                        numeric
                        and not isinstance(value, (bool, list))
                        and data["unit"] == finding["unit"]
                    ):
                        try:
                            verified |= Decimal(str(value)) == Decimal(data["value"])
                        except ArithmeticError:
                            pass
            if numeric and ctx.config["workflow"]["verify_numeric_answers"] and not verified:
                if state["correction_used"]:
                    stop(state, ctx, "unable", "verification_failed")
                else:
                    state["correction_used"] = True
                    policy(state, ctx, "verification_required")
                return
    state["answer"] = answer
    state["result"] = {"answer": "answered", "clarify": "clarified", "unable": "unable"}[kind]
    emit(state, ctx.started, "final_output", state["result"], answer)


def route_action(state: WorkerState, runtime: Runtime[RunContext]) -> WorkerState:
    state = state.copy()
    ctx = runtime.context
    action = state["action"]
    state["action"] = None
    if action is None:
        return state
    if action["kind"] == "finish":
        finish(state, ctx, action["answer"])
    else:
        if action["name"] == "execute_readonly_sql":
            state["sql_attempted"] = True
            if len(action["arguments"]["sql"].encode()) > MAX_SQL_BYTES:
                if consume_call(state, ctx):
                    policy(
                        state,
                        ctx,
                        "sql_too_large",
                        safety=True,
                        correlation=f"call_{state['calls']}",
                    )
                return state
        begin_call(state, ctx, action, "model")
    return state


def report_result(state: WorkerState, ctx: RunContext, pending: dict, result: dict):
    name = pending["call"]["name"]
    code = result.get("code", "ok")
    emit(state, ctx.started, "tool_result", code, result, pending["correlation"])
    recent = ctx.config["context"]["recent_tool_results"]
    state["recent"] = [*state["recent"], bounded_result(result)][-recent:]
    if result["status"] == "error":
        state["failures"] = {**state["failures"], name: result}
        if code in SAFETY_ERRORS:
            policy(state, ctx, code, safety=True)
        elif code == "sandbox_unavailable":
            stop(state, ctx, "infrastructure_error", code)
        elif ctx.config["workflow"]["retry_policy"] == "none":
            stop(state, ctx, "unable", "recovery_disabled")
        return

    data = result["data"]
    if name == "list_tables":
        state["metadata"] = data["tables"]
    elif name == "describe_schema":
        state["metadata"] = sorted(
            set(state["metadata"]) | {table["name"] for table in data["tables"]}
        )
    elif name == "execute_readonly_sql":
        state["evidence"] = {**state["evidence"], data["query_id"]: data}
    elif name == "validate_calculation":
        state["evidence"] = {**state["evidence"], data["calculation_id"]: data}
    if name in state["failures"]:
        error = state["failures"][name]
        error_id = error["error_id"]
        if name == "execute_readonly_sql" and state["fault_error_id"]:
            error_id = state["fault_error_id"]
            state["fault_error_id"] = None
        emit(
            state,
            ctx.started,
            "recovery",
            "recovered",
            {"tool": name, "error_id": error_id},
            pending["correlation"],
        )
        state["failures"] = {key: item for key, item in state["failures"].items() if key != name}


def local_error(state: WorkerState, pending: dict, code: str) -> dict:
    return {
        "status": "error",
        "name": pending["call"]["name"],
        "error_id": f"runner_error_{state['calls']}",
        "code": code,
    }


async def dispatch(state: WorkerState, runtime: Runtime[RunContext]) -> WorkerState:
    state = state.copy()
    ctx = runtime.context
    pending = state["pending"]
    state["pending"] = None
    call = pending["call"]
    name = call["name"]
    if (
        state["input_tokens"] >= ctx.config["limits"]["max_input_tokens"]
        or state["output_tokens"] >= ctx.config["limits"]["max_output_tokens"]
    ):
        stop(state, ctx, "budget_exhausted", "model_budget")
        return state

    query = None
    error = None
    if name == "execute_readonly_sql":
        try:
            query = check_query(call["arguments"]["sql"], ctx.mcp.schema, ctx.mcp.tables)
        except QueryRejected as exc:
            error = exc.code
        if (
            error not in SAFETY_ERRORS
            and not state["metadata"]
            and ctx.config["workflow"]["schema_inspection"] == "before_first_sql"
        ):
            policy(state, ctx, "schema_preflight")
            begin_call(state, ctx, tool_call("list_tables"), "harness")
            return state

    if error is not None:
        report_result(state, ctx, pending, local_error(state, pending, error))
        return state
    if query and query.sql in state["failed_sql"]:
        if state["failed_sql"][query.sql] not in TRANSIENT or query.sql in state["repeated_sql"]:
            policy(state, ctx, "repeated_failed_sql")
            return state
    retries = state["retries"].get(name, 0)
    if name in state["failures"]:
        if retries >= ctx.config["limits"]["max_retries_per_tool"]:
            policy(state, ctx, "retry_budget")
            return state
        state["retries"] = {**state["retries"], name: retries + 1}
    if query and query.sql in state["failed_sql"]:
        state["repeated_sql"] = [*state["repeated_sql"], query.sql]

    try:
        async with asyncio.timeout_at(ctx.deadline):
            result = await call_tool(state, ctx, call)
    except TimeoutError:
        stop(state, ctx, "budget_exhausted", "task_deadline")
        return state
    except Exception:
        stop(state, ctx, "infrastructure_error", "mcp_transport")
        return state
    if result is None:
        result = local_error(state, pending, "malformed_result")
    if private_data(result):
        stop(state, ctx, "infrastructure_error", "redaction_required")
        return state
    fault = ctx.request["fault"]
    if query and fault and not state["fault_used"]:
        expected = fault["kind"]
        if result.get("code") == expected:
            state["fault_used"] = True
            state["fault_error_id"] = result["error_id"]
            emit(state, ctx.started, "fault", expected, fault, pending["correlation"])
    report_result(state, ctx, pending, result)
    if query and result["status"] == "error":
        state["failed_sql"] = {**state["failed_sql"], query.sql: result["code"]}
        if (
            state["result"] is None
            and result["code"] == "schema_error"
            and ctx.config["workflow"]["schema_inspection"] == "on_error"
            and retries < ctx.config["limits"]["max_retries_per_tool"]
        ):
            begin_call(
                state,
                ctx,
                tool_call("describe_schema", tables=list(query.relations[:6])),
                "harness",
            )
    return state


async def call_tool(state: WorkerState, ctx: RunContext, call: dict) -> dict | None:
    if call["name"] == "inspect_query_error":
        key = call["arguments"]["error_id"]
        if key.startswith("runner_error_"):
            error = next(
                (
                    event["payload"]
                    for event in state["events"]
                    if event["kind"] == "tool_result" and event["payload"].get("error_id") == key
                ),
                None,
            )
            if error is not None:
                return {"status": "ok", "name": call["name"], "data": hint(key, error["code"])}
    return await ctx.mcp.call(call)


def next_node(state: WorkerState) -> str:
    if state["result"] is not None:
        return END
    if state["pending"] is not None:
        return "dispatch"
    return "model_turn"


def worker_graph(checkpointer=None):
    graph = StateGraph(WorkerState, context_schema=RunContext)
    graph.add_node("model_turn", model_turn)
    graph.add_node("route_action", route_action)
    graph.add_node("dispatch", dispatch)
    graph.add_edge(START, "model_turn")
    graph.add_conditional_edges(
        "model_turn",
        lambda state: END if state["result"] else "route_action",
        [END, "route_action"],
    )
    for name in ("route_action", "dispatch"):
        graph.add_conditional_edges(name, next_node, [END, "model_turn", "dispatch"])
    return graph.compile(checkpointer=checkpointer)


def validate_request(request: dict):
    if not json_types(request) or not accepts("ExecuteTaskRequest", request):
        raise ValueError("Invalid execution request")
    task, manifest, config = request["task"], request["manifest"], request["harness"]
    _, split, variant, category, _ = task["task_key"].split("/")
    if (
        split not in {"dev", "validation"}
        or split != task["split"]
        or variant != task["variant_id"]
        or category != task["category"]
        or manifest["task_key"] != task["task_key"]
        or manifest["task_input_hash"] != digest(task)
        or manifest["config_hash"] != digest(config)
        or (manifest["stage"] == "validate") != (split == "validation")
        or (request["fault"] is not None and task["category"] != "tool_failures")
    ):
        raise ValueError("Execution provenance mismatch")


async def execute(
    request: dict,
    model: Model,
    dsn: str,
    catalog: Path,
    *,
    checkpointer: InMemorySaver | None = None,
) -> dict:
    validate_request(request)
    manifest = request["manifest"]
    if model.mode != manifest["mode"] or (
        model.mode == "live" and model.settings != manifest["worker"]
    ):
        raise ValueError("Worker adapter does not match the pinned run manifest")
    now = asyncio.get_running_loop().time()
    started = monotonic()
    wall_time = datetime.now(UTC)
    deadline_utc = min(
        datetime.fromisoformat(request["deadline"]), wall_time + timedelta(seconds=90)
    )
    remaining = (deadline_utc - wall_time).total_seconds()
    deadline = now + remaining
    state = STATE.validate_python(
        {
            "version": 1,
            "run_id": manifest["run_id"],
            "deadline_utc": deadline_utc.isoformat().replace("+00:00", "Z"),
            "turns": 0,
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "events": [],
            "recent": [],
            "metadata": [],
            "evidence": {},
            "failures": {},
            "retries": {},
            "failed_sql": {},
            "repeated_sql": [],
            "fault_used": False,
            "fault_error_id": None,
            "sql_attempted": False,
            "correction_used": False,
            "action": None,
            "pending": None,
            "answer": None,
            "result": None,
        },
        strict=True,
    )
    emit(
        state,
        started,
        "start",
        "started",
        {"task_key": manifest["task_key"], "config_hash": manifest["config_hash"]},
    )
    graph = worker_graph(checkpointer if checkpointer is not None else InMemorySaver())
    config = {"configurable": {"thread_id": manifest["run_id"]}, "recursion_limit": 80}
    if remaining <= 0:
        state["result"] = "budget_exhausted"
        emit(
            state,
            started,
            "policy_decision",
            "task_deadline",
            {"reason": "task_deadline", "safety_violation": False},
        )
    else:
        try:
            async with asyncio.timeout_at(deadline):
                async with open_dataops(
                    dsn, request["task"]["variant_id"], catalog, request["fault"]
                ) as mcp:
                    with tracing_context(enabled=False):
                        state = await graph.ainvoke(
                            state,
                            config,
                            context=RunContext(request, model, mcp, started, deadline),
                            durability="sync",
                        )
        except TimeoutError:
            snapshot = await graph.aget_state(config)
            state = snapshot.values or state
            state["answer"] = None
            state["result"] = "budget_exhausted"
            emit(
                state,
                started,
                "policy_decision",
                "task_deadline",
                {"reason": "task_deadline", "safety_violation": False},
            )
        except (OSError, ValueError, ExceptionGroup):
            snapshot = await graph.aget_state(config)
            state = snapshot.values or state
            state["answer"] = None
            state["result"] = "infrastructure_error"
            emit(
                state,
                started,
                "policy_decision",
                "mcp_transport",
                {"reason": "mcp_transport", "safety_violation": False},
            )

    state = STATE.validate_python(state, strict=True)
    events = state["events"]
    replay_events = [
        {key: value for key, value in event.items() if key not in {"run_id", "elapsed_ms"}}
        for event in events
    ]
    for event in replay_events:
        if event["kind"] == "model_usage":
            event["payload"] = {"input_tokens": 0, "output_tokens": 0, "request_id": None}
    envelope = {
        "schema_version": 1,
        "manifest": manifest,
        "answer": state["answer"],
        "events": events,
        "result": state["result"],
        "trace_digest": digest(replay_events),
    }
    if not accepts("RunEnvelope", envelope):
        raise ValueError("Invalid runner envelope")
    return envelope
