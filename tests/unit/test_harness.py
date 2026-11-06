import asyncio
import json

import httpx2
import openai
import pytest
from harnesslab_contracts.validate import definition
from harnesslab_runner.config import apply_patch, digest, read_harness
from harnesslab_runner.fixture import BASELINE
from harnesslab_runner.model import ActionSchema, OpenAITurns
from jsonschema import Draft202012Validator


def test_baseline_canonical_hash(harness):
    source = BASELINE.read_bytes()
    loaded = read_harness(source)
    assert loaded.yaml_bytes == source
    assert loaded.config == harness
    assert loaded.content_hash == digest(harness)
    assert read_harness(b"# comment\n" + source).canonical == loaded.canonical


@pytest.mark.parametrize(
    "mutate",
    [
        lambda b: b + b"\nschema_version: 1\n",
        lambda b: b + b"\n---\n{}\n",
        lambda b: b + b"\nunknown: &anchor 1\n",
        lambda b: b + b"\nunknown: *anchor\n",
        lambda b: b + b"\nunknown: !custom 1\n",
        lambda b: b + b"\n<<: {schema_version: 1}\n",
        lambda b: b + b'\n"<<": 1\n',
        lambda b: b.replace(b"max_tool_calls: 12", b"max_tool_calls: 12.0"),
        lambda b: b.replace(b"max_tool_calls: 12", b"max_tool_calls: true"),
        lambda b: b.replace(b"max_tool_calls: 12", b"max_tool_calls: 13"),
        lambda b: b.replace(b"recent_tool_results: 4", b"recent_tool_results: 2025-01-01"),
        lambda b: b + b"#" * 16384,
    ],
)
def test_yaml_fails_closed(mutate):
    with pytest.raises(ValueError):
        read_harness(mutate(BASELINE.read_bytes()))


def replacement(path, value):
    return {"op": "replace", "path": path, "value": value}


@pytest.mark.parametrize(
    ("path", "value"),
    [
        ("/prompt/task_guidance", "Use evidence."),
        ("/workflow/schema_inspection", "before_first_sql"),
        ("/workflow/verify_numeric_answers", True),
        ("/workflow/retry_policy", "none"),
        ("/context/recent_tool_results", 2),
        ("/limits/max_tool_calls", 4),
        ("/limits/max_retries_per_tool", 0),
    ],
)
def test_each_mutable_path_rehashes(harness, path, value):
    before = digest(harness)
    config = apply_patch(harness, [replacement(path, value)])
    _, group, key = path.split("/")
    assert config[group][key] == value
    assert digest(config) != before
    assert digest(harness) == before


@pytest.mark.parametrize(
    "ops",
    [
        [],
        [replacement("/limits/max_tool_calls", 4)] * 2,
        [replacement("/limits/max_tool_calls", 12)],
        [replacement("/limits/max_tool_calls", True)],
        [replacement("/limits/max_tool_calls", 4.0)],
        [replacement("/limits/max_tool_calls", 3)],
        [replacement("/limits/max_model_turns", 4)],
        [replacement("/context/recent_tool_results", 4) | {"extra": True}],
        [replacement("/limits/max_tool_calls", 4)] * 3,
    ],
)
def test_invalid_patches(harness, ops):
    with pytest.raises(ValueError):
        apply_patch(harness, ops)


def test_strict_provider_schema_matches_all_action_variants():
    schema = ActionSchema().json_schema()
    assert schema["type"] == "object"
    assert set(schema["required"]) == {"action"}
    assert len(schema["properties"]["action"]["anyOf"]) == 7
    Draft202012Validator.check_schema(schema)

    def assert_closed(node):
        assert set(node) <= {
            "type",
            "properties",
            "required",
            "additionalProperties",
            "anyOf",
            "items",
            "enum",
        }
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            for child in node["properties"].values():
                assert_closed(child)
        for child in node.get("anyOf", []):
            assert_closed(child)
        if "items" in node:
            assert_closed(node["items"])

    assert_closed(schema)
    assert len(definition("ToolCall")["oneOf"]) == 6


def test_live_adapter_wire_is_single_turn_stateless_and_bounded(monkeypatch):
    settings = {
        "snapshot": "gpt-4.1-2025-04-14",
        "timeout_ms": 1000,
        "reasoning_effort": None,
        "temperature": "0",
        "top_p": None,
    }
    original = openai.AsyncOpenAI
    requests = []
    answer = {"action": {"kind": "finish", "answer": {"kind": "unable", "reason": "fixture"}}}

    def handler(request):
        requests.append(json.loads(request.content))
        assert str(request.url) == "https://api.openai.com/v1/responses"
        return httpx2.Response(
            200,
            json={
                "id": "resp_test",
                "object": "response",
                "created_at": 0,
                "status": "completed",
                "model": settings["snapshot"],
                "output": [
                    {
                        "id": "msg_test",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {"type": "output_text", "text": json.dumps(answer), "annotations": []}
                        ],
                    }
                ],
                "usage": {
                    "input_tokens": 111,
                    "output_tokens": 18,
                    "total_tokens": 129,
                    "input_tokens_details": {"cached_tokens": 0},
                    "output_tokens_details": {"reasoning_tokens": 0},
                },
                "parallel_tool_calls": False,
                "tool_choice": "none",
                "tools": [],
            },
            headers={"x-request-id": "req_test"},
        )

    def fake_client(**options):
        assert options["max_retries"] == 0
        assert options["http_client"].trust_env is False
        options["http_client"] = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
        return original(**options)

    monkeypatch.setattr(openai, "AsyncOpenAI", fake_client)

    async def run():
        async with OpenAITurns(settings, "fixture-key") as model:
            turn = await model.turn('{"task":"data"}', 123)
            assert turn.action == answer
            assert (turn.input_tokens, turn.output_tokens, turn.request_id) == (111, 18, "req_test")

    asyncio.run(run())
    assert len(requests) == 1
    [wire] = requests
    assert wire["store"] is False
    assert wire["max_output_tokens"] == 123
    assert wire["model"] == settings["snapshot"]
    assert not wire.get("tools")
    assert "previous_response_id" not in wire and "conversation" not in wire
    assert wire["text"]["format"]["strict"] is True

    with pytest.raises(ValueError, match="Unsupported or unpinned"):
        OpenAITurns({**settings, "snapshot": "gpt-4.1"}, "fixture-key")
    with pytest.raises(ValueError, match="Unsupported reasoning"):
        OpenAITurns({**settings, "reasoning_effort": "high"}, "fixture-key")
