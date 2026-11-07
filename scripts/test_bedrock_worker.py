#!/usr/bin/env python3
"""Interactive test script for AWS Bedrock Claude Sonnet 4.5 in HarnessLab."""

import asyncio
import json
import sys
from pathlib import Path
from harnesslab_runner.model import BedrockConverseTurns

PROFILE_PATH = Path("harnesses/profiles/worker-bedrock-sonnet-4-5.json")


async def run_test():
    if not PROFILE_PATH.exists():
        print(f"Error: Profile not found at {PROFILE_PATH}")
        sys.exit(1)

    with PROFILE_PATH.open() as f:
        settings = json.load(f)

    print("=================================================================")
    print("  HarnessLab Bedrock Test: Claude Sonnet 4.5 (us-east-1)")
    print("=================================================================")
    print(f"Model ID : {settings['snapshot']}")
    print(f"Region   : {settings['region']}")
    print(f"Timeout  : {settings['timeout_ms']} ms")
    print("-----------------------------------------------------------------")

    turns = BedrockConverseTurns(settings)

    # Turn 1: Asking a question that requires schema discovery
    prompt = "How many customers signed up in 2025? Check the database schema first."
    print(f"\n[Turn 1] User Prompt:\n  \"{prompt}\"")
    print("\nSending request to AWS Bedrock...")

    payload = json.dumps({
        "task": {
            "task_key": "synthetic-business-v1/dev/variant-a/schema_discovery/01",
            "prompt": prompt,
            "output_keys": [{"key": "customer_count", "unit": "count", "value_type": "integer"}],
        },
        "task_guidance": "Investigate the request and cite the returned data.",
        "known_tables": [],
        "recent_results": [],
        "evidence_ids": [],
        "policy_event": None,
    })

    t1 = await turns.turn(payload, max_output=1000)
    print(f"\n[Turn 1 Response Received]")
    print(f"  Input Tokens  : {t1.input_tokens}")
    print(f"  Output Tokens : {t1.output_tokens}")
    print(f"  Request ID    : {t1.request_id}")
    print(f"  Usage Valid   : {t1.usage_valid}")
    print(f"  Action Emitted:\n{json.dumps(t1.action, indent=4)}")

    # Turn 2: Providing schema and expecting SQL execution
    print("\n-----------------------------------------------------------------")
    print("[Turn 2] Simulating tool result: 'customers' table discovered.")
    print("Sending Turn 2 to Bedrock...")

    payload_turn2 = json.dumps({
        "task": {
            "task_key": "synthetic-business-v1/dev/variant-a/schema_discovery/01",
            "prompt": prompt,
            "output_keys": [{"key": "customer_count", "unit": "count", "value_type": "integer"}],
        },
        "task_guidance": "Investigate the request and cite the returned data.",
        "known_tables": ["customers"],
        "recent_results": [
            {
                "call": "call_1",
                "tool": "describe_schema",
                "result": {
                    "tables": [
                        {
                            "table": "customers",
                            "columns": [
                                {"name": "id", "type": "varchar"},
                                {"name": "signup_at", "type": "timestamp"},
                                {"name": "region", "type": "varchar"},
                            ],
                        }
                    ]
                },
            }
        ],
        "evidence_ids": [],
        "policy_event": None,
    })

    t2 = await turns.turn(payload_turn2, max_output=1000)
    print(f"\n[Turn 2 Response Received]")
    print(f"  Input Tokens  : {t2.input_tokens}")
    print(f"  Output Tokens : {t2.output_tokens}")
    print(f"  Request ID    : {t2.request_id}")
    print(f"  Action Emitted:\n{json.dumps(t2.action, indent=4)}")

    print("\n=================================================================")
    print("  Success! Claude Sonnet 4.5 is fully operational via Bedrock.")
    print("=================================================================")


if __name__ == "__main__":
    asyncio.run(run_test())
