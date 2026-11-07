import asyncio

import pytest
from botocore.stub import Stubber
from harnesslab_runner.model import BedrockConverseTurns


def test_bedrock_settings_validation():
    valid = {
        "provider": "bedrock",
        "region": "us-east-1",
        "snapshot": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "timeout_ms": 60000,
        "reasoning_effort": None,
        "temperature": "0.0",
        "top_p": None,
    }
    turns = BedrockConverseTurns(valid)
    assert turns.mode == "live"
    assert turns.settings["provider"] == "bedrock"
    assert turns.settings["region"] == "us-east-1"
    assert turns.estimate("test payload") > 0

    # Wrong provider
    with pytest.raises(ValueError):
        BedrockConverseTurns({**valid, "provider": "openai"})

    # Missing region
    with pytest.raises(ValueError):
        BedrockConverseTurns({**valid, "region": ""})

    # Invalid snapshot pattern
    with pytest.raises(ValueError):
        BedrockConverseTurns({**valid, "snapshot": "invalid/path*model"})


def test_bedrock_converse_turn_tool_call():
    settings = {
        "provider": "bedrock",
        "region": "us-east-1",
        "snapshot": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "timeout_ms": 60000,
        "reasoning_effort": None,
        "temperature": "0.0",
        "top_p": None,
    }
    turns = BedrockConverseTurns(settings)

    stubber = Stubber(turns.client)
    expected_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "toolUse": {
                            "toolUseId": "tooluse_123",
                            "name": "list_tables",
                            "input": {},
                        }
                    }
                ],
            }
        },
        "stopReason": "tool_use",
        "usage": {
            "inputTokens": 120,
            "outputTokens": 25,
            "totalTokens": 145,
        },
        "metrics": {"latencyMs": 100},
        "ResponseMetadata": {"RequestId": "req-12345"},
    }

    stubber.add_response("converse", expected_response)

    async def run():
        with stubber:
            return await turns.turn("List tables", 500)

    turn = asyncio.run(run())

    assert turn.action == {
        "action": {
            "kind": "tool",
            "name": "list_tables",
            "arguments": {},
        }
    }
    assert turn.input_tokens == 120
    assert turn.output_tokens == 25
    assert turn.request_id == "req-12345"
    assert turn.usage_valid is True
