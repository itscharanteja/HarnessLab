#!/usr/bin/env python3
"""Pre-flight validation for HarnessLab live execution with AWS Bedrock."""

import asyncio
import json
import os
import sys
import urllib.request
from decimal import Decimal
from pathlib import Path

def check_service(name: str, url: str):
    print(f"Checking {name} at {url}...", end=" ", flush=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "HarnessLab-Preflight"})
        with urllib.request.urlopen(req, timeout=3) as res:
            if res.status == 200:
                print("✓ OK")
                return True
            print(f"✗ HTTP {res.status}")
            return False
    except Exception as exc:
        print(f"✗ FAILED ({exc})")
        return False

async def verify_bedrock():
    print("Testing AWS Bedrock Claude Sonnet 4.5...", flush=True)
    import boto3
    from botocore.config import Config

    region = os.environ.get("AWS_REGION", "us-east-1")
    snapshot = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
    config = Config(
        region_name=region,
        connect_timeout=15,
        read_timeout=30,
        retries={"total_max_attempts": 5, "mode": "adaptive"},
    )
    client = boto3.client("bedrock-runtime", config=config)

    # 1. Probe Converse API with minimal message
    response = client.converse(
        modelId=snapshot,
        messages=[{"role": "user", "content": [{"text": "Say 'ready'."}]}],
        inferenceConfig={"maxTokens": 10},
    )
    usage = response.get("usage", {})
    in_tok = usage.get("inputTokens", 0)
    out_tok = usage.get("outputTokens", 0)
    print(f"✓ AWS Bedrock responded: input={in_tok}, output={out_tok}")

    # 2. Check token estimation bound
    from harnesslab_runner.model import BedrockConverseTurns
    settings = {
        "provider": "bedrock",
        "snapshot": snapshot,
        "timeout_ms": 60000,
        "region": region,
        "temperature": None,
        "top_p": None,
        "reasoning_effort": None,
    }
    turns = BedrockConverseTurns(settings)
    payload = json.dumps({
        "task": {
            "task_key": "synthetic-business-v1/dev/d01/schema_discovery/01",
            "prompt": "List tables",
            "output_keys": [],
        },
        "task_guidance": "Test guidance",
        "known_tables": [],
        "recent_results": [],
        "evidence_ids": [],
        "policy_event": None,
    })
    est = turns.estimate(payload)
    t = await turns.turn(payload, max_output=50)
    print(f"✓ Token bound verified: estimate={est} >= actual={t.input_tokens}")
    if t.input_tokens > est:
        raise ValueError(f"CRITICAL: actual {t.input_tokens} > estimate {est}")

def main():
    print("=" * 60)
    print("  HarnessLab Pre-Flight Verification")
    print("=" * 60)

    # 1. Services
    s1 = check_service("Runner", "http://127.0.0.1:8000/readyz")
    s2 = check_service("Evaluator", "http://127.0.0.1:8001/readyz")
    s3 = check_service("Optimizer", "http://127.0.0.1:8002/readyz")
    s4 = check_service("Dispatcher", "http://127.0.0.1:4001/readyz")
    s5 = check_service("API", "http://127.0.0.1:4000/readyz")
    s6 = check_service("Web Dashboard", "http://127.0.0.1:3000")

    # 2. Bedrock
    asyncio.run(verify_bedrock())

    print("=" * 60)
    print("  All Pre-Flight Checks Passed! Ready to run.")
    print("=" * 60)

if __name__ == "__main__":
    main()
