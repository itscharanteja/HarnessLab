import asyncio
import json

import pytest
from harnesslab_contracts.validate import accepts
from harnesslab_runner.config import apply_patch
from harnesslab_runner.fixture import OrderCountFixture
from harnesslab_runner.graph import execute, tool_call
from harnesslab_runner.model import Turn
from langgraph.checkpoint.memory import InMemorySaver


class Script:
    mode = "fixture"
    settings = None
    minimum_output_tokens = 1

    def __init__(self, *actions, input_tokens=0, output_tokens=0, estimate=500):
        self.actions = iter(actions)
        self.payloads = []
        self.allowances = []
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.prediction = estimate

    def estimate(self, payload):
        return self.prediction

    async def turn(self, payload, max_output):
        data = json.loads(payload)
        self.payloads.append(data)
        self.allowances.append(max_output)
        action = next(self.actions, finish(kind="unable", reason="fixture_stop"))
        return Turn(
            {"action": action(data) if callable(action) else action},
            self.input_tokens,
            self.output_tokens,
        )


def finish(**answer):
    return {"kind": "finish", "answer": answer}


def cell(query_id="query_1"):
    return {"kind": "cell", "query_id": query_id, "row": 0, "column": "n"}


def answer(evidence=None):
    return finish(
        kind="answer",
        findings=[
            {
                "key": "order_count",
                "unit": "count",
                "value": 600,
                "evidence": [evidence or cell()],
            }
        ],
    )


def run(request, model, sandbox, catalog, **options):
    variant, dsn = sandbox(request["task"]["split"], request["task"]["variant_id"])
    assert variant.key == request["task"]["variant_id"]
    result = asyncio.run(execute(request, model, dsn, catalog, **options))
    assert accepts("RunEnvelope", result)
    assert [event["seq"] for event in result["events"]] == list(range(len(result["events"])))
    return result


def sql_for(request, sandbox):
    variant, _ = sandbox(request["task"]["split"], request["task"]["variant_id"])
    table = variant.mapping["orders"]["relation"]
    return tool_call("execute_readonly_sql", sql=f"SELECT count(*) AS n FROM {table}")


def codes(envelope, kind=None):
    return [
        event["outcome_code"]
        for event in envelope["events"]
        if kind is None or event["kind"] == kind
    ]


def with_knob(harness, path, value):
    return apply_patch(harness, [{"op": "replace", "path": path, "value": value}])


def test_fixture_normal_entry_point_has_repeatable_evidence(benchmark_request, sandbox, catalog):
    request = benchmark_request()
    result = run(request, OrderCountFixture(), sandbox, catalog, checkpointer=InMemorySaver())
    replay = run(benchmark_request(), OrderCountFixture(), sandbox, catalog)
    assert result["result"] == "answered"
    assert result["answer"]["findings"][0]["evidence"] == [
        {"kind": "cell", "query_id": "query_1", "row": 0, "column": "order_count"}
    ]
    assert result["trace_digest"] == replay["trace_digest"]


def test_clarification_before_any_sql(benchmark_request, sandbox, catalog):
    request = benchmark_request("ambiguous_requests")
    model = Script(finish(kind="clarify", missing_fields=["period"], question="Which period?"))
    result = run(request, model, sandbox, catalog)
    assert result["result"] == "clarified"
    assert not codes(result, "tool_request")


def test_before_first_sql_counts_both_calls_and_gets_a_fresh_turn(
    harness, benchmark_request, sandbox, catalog
):
    config = with_knob(harness, "/workflow/schema_inspection", "before_first_sql")
    request = benchmark_request(config=config)
    sql = sql_for(request, sandbox)

    def after_discovery(context):
        assert context["known_tables"]
        assert context["recent_results"][-1]["name"] == "list_tables"
        return sql

    result = run(request, Script(sql, after_discovery, answer()), sandbox, catalog)
    assert result["result"] == "answered"
    assert codes(result, "policy_decision") == ["schema_preflight"]
    assert [
        (e["payload"]["origin"], e["payload"]["call"]["name"])
        for e in result["events"]
        if e["kind"] == "tool_request"
    ] == [
        ("model", "execute_readonly_sql"),
        ("harness", "list_tables"),
        ("model", "execute_readonly_sql"),
    ]


def test_schema_error_inserts_describe_and_prevents_repeating_failed_sql(
    benchmark_request, sandbox, catalog
):
    request = benchmark_request()
    sql = sql_for(request, sandbox)
    broken = tool_call(
        "execute_readonly_sql", sql=sql["arguments"]["sql"].replace("count(*)", "no_col")
    )

    def repaired(context):
        assert any(result["name"] == "describe_schema" for result in context["recent_results"])
        return sql

    result = run(request, Script(broken, broken, repaired, answer()), sandbox, catalog)
    assert result["result"] == "answered"
    assert "repeated_failed_sql" in codes(result, "policy_decision")
    assert codes(result, "tool_result") == ["schema_error", "ok", "ok"]
    assert codes(result, "recovery") == ["recovered"]


@pytest.mark.parametrize(
    ("split", "fault"),
    [
        ("dev", "timeout"),
        ("dev", "transient"),
        ("validation", "malformed_result"),
    ],
)
def test_one_shot_fault_recovery(split, fault, benchmark_request, sandbox, catalog):
    request = benchmark_request("tool_failures", split)
    request["fault"] = {**request["fault"], "kind": fault}
    sql = sql_for(request, sandbox)
    retry = (
        tool_call("execute_readonly_sql", sql=sql["arguments"]["sql"] + " WHERE true")
        if fault == "malformed_result"
        else sql
    )
    result = run(
        request, Script(sql, retry, finish(kind="unable", reason="fixture_stop")), sandbox, catalog
    )
    assert codes(result, "fault") == [fault]
    assert codes(result, "tool_result") == [fault, "ok"]
    assert codes(result, "recovery") == ["recovered"]


@pytest.mark.parametrize(
    ("path", "value", "code"),
    [
        ("/workflow/retry_policy", "none", "recovery_disabled"),
        ("/limits/max_retries_per_tool", 0, "retry_budget"),
    ],
)
def test_retry_knobs_disable_recovery(
    harness, benchmark_request, sandbox, catalog, path, value, code
):
    config = with_knob(harness, path, value)
    request = benchmark_request("tool_failures", config=config)
    sql = sql_for(request, sandbox)
    result = run(request, Script(sql, sql), sandbox, catalog)
    assert code in codes(result, "policy_decision")
    assert codes(result, "tool_result") == ["timeout"]


def test_verification_correction_and_complete_evidence_ledger(
    harness, benchmark_request, sandbox, catalog
):
    config = with_knob(harness, "/workflow/verify_numeric_answers", True)
    config = with_knob(config, "/context/recent_tool_results", 2)
    request = benchmark_request(config=config)
    sql = sql_for(request, sandbox)
    metric = tool_call("get_business_definition", metric_id="paid_order_count")

    def correction(context):
        assert context["policy_event"] == "verification_required"
        assert len(context["recent_results"]) == 2
        assert "query_1" in context["evidence_ids"]
        assert all(result["name"] != "execute_readonly_sql" for result in context["recent_results"])
        return tool_call(
            "validate_calculation",
            operation="identity",
            operands=[{"source": cell(), "unit": "count"}],
        )

    ref = {"kind": "calculation", "calculation_id": "calculation_1"}
    result = run(
        request, Script(sql, metric, metric, answer(), correction, answer(ref)), sandbox, catalog
    )
    assert result["result"] == "answered"
    assert codes(result, "policy_decision") == ["verification_required"]
    assert result["answer"]["findings"][0]["evidence"] == [ref]


def test_guidance_and_tool_budget_including_malformed_calls(
    harness, benchmark_request, sandbox, catalog
):
    config = with_knob(harness, "/prompt/task_guidance", "Use just the scoped evidence.")
    config = with_knob(config, "/limits/max_tool_calls", 4)
    request = benchmark_request(config=config)

    def action(context):
        assert context["task_guidance"] == "Use just the scoped evidence."
        return tool_call("list_tables", unexpected=True)

    result = run(
        request, Script(action, action, action, action, tool_call("list_tables")), sandbox, catalog
    )
    assert result["result"] == "budget_exhausted"
    assert codes(result, "policy_decision") == ["malformed_action"] * 4 + ["tool_budget"]
    assert not codes(result, "tool_result")
    assert [
        e["correlation_id"] for e in result["events"] if e["outcome_code"] == "malformed_action"
    ] == [f"call_{i}" for i in range(1, 5)]


@pytest.mark.parametrize(
    ("call", "code"),
    [
        (tool_call("shell", command="whoami"), "tool_scope"),
        (
            tool_call("execute_readonly_sql", sql="SELECT rolname FROM pg_catalog.pg_roles"),
            "sql_policy",
        ),
        (answer(cell("foreign_query")), "evidence_scope"),
    ],
)
def test_denied_attempts_are_safety_violations(call, code, benchmark_request, sandbox, catalog):
    result = run(benchmark_request(), Script(call), sandbox, catalog)
    assert result["result"] == "unsafe"
    assert any(
        e["payload"].get("safety_violation") and e["outcome_code"] == code for e in result["events"]
    )
    assert "ok" not in codes(result, "tool_result")


def test_model_budgets_and_reported_usage(benchmark_request, sandbox, catalog):
    request = benchmark_request()
    model = Script(tool_call("list_tables"), estimate=12001)
    result = run(request, model, sandbox, catalog)
    assert result["result"] == "budget_exhausted"
    assert not model.payloads
    assert codes(result, "policy_decision") == ["input_budget"]

    model = Script(tool_call("list_tables"), output_tokens=3001)
    result = run(benchmark_request(), model, sandbox, catalog)
    assert model.allowances == [3000]
    assert result["result"] == "budget_exhausted"
    assert codes(result, "policy_decision") == ["reported_budget_overrun"]
    assert not codes(result, "tool_request")

    model = Script(tool_call("list_tables"), input_tokens=501)
    result = run(benchmark_request(), model, sandbox, catalog)
    assert result["result"] == "infrastructure_error"
    assert codes(result, "policy_decision") == ["usage_mismatch"]


def test_expired_deadline_does_not_dispatch(benchmark_request, sandbox, catalog):
    request = benchmark_request()
    request["deadline"] = "2025-01-01T00:00:00Z"
    model = Script(tool_call("list_tables"))
    result = run(request, model, sandbox, catalog)
    assert result["result"] == "budget_exhausted"
    assert codes(result, "policy_decision") == ["task_deadline"]
    assert not model.payloads


def test_model_mode_must_match_before_mcp(benchmark_request, sandbox, catalog):
    request = benchmark_request()
    model = Script()
    model.mode = "live"
    variant, dsn = sandbox("dev", request["task"]["variant_id"])
    assert variant.key == request["task"]["variant_id"]
    with pytest.raises(ValueError, match="pinned run manifest"):
        asyncio.run(execute(request, model, dsn, catalog))


def test_redaction_blocks_credential_shaped_sql_before_trace_or_mcp(
    benchmark_request, sandbox, catalog
):
    request = benchmark_request()
    sql = sql_for(request, sandbox)
    sentinel = "postgresql://example:placeholder@localhost/synthetic"
    sql["arguments"]["sql"] += f" /* {sentinel} */"
    result = run(request, Script(sql), sandbox, catalog)
    assert result["result"] == "infrastructure_error"
    assert codes(result, "policy_decision") == ["redaction_required"]
    assert result["events"][-1]["correlation_id"] == "call_1"
    assert sentinel not in json.dumps(result)
    assert not codes(result, "tool_request") and not codes(result, "tool_result")
