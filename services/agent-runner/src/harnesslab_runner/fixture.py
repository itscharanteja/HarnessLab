import argparse
import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from harnesslab_mcp.tools import json_bytes

from .config import digest, read_harness
from .graph import execute, tool_call
from .model import POLICY, Turn

BASELINE = Path("harnesses/baseline.yaml")
CATALOG = Path("datasets/synthetic-business/metrics.json").resolve()
DEVELOPMENT = Path("benchmarks/development")
RUNTIME_MAP = Path(".artifacts/benchmark-fixture/.runtime/dev.json")
FIXTURE_SETTINGS = {
    "snapshot": "fixture-worker-v1",
    "timeout_ms": 5000,
    "reasoning_effort": None,
    "temperature": None,
    "top_p": None,
}


def fixture_request(task, harness, manifest, fault=None):
    meta = next(row for row in manifest["tasks"] if row["id"] == task["task_key"])
    if meta["input_hash"] != digest(task) or meta["fault_digest"] != digest(fault):
        raise ValueError("Fixture provenance mismatch")
    variant = next(row for row in manifest["variants"] if row["id"] == task["variant_id"])
    return {
        "schema_version": 1,
        "task": task,
        "harness": harness,
        "fault": fault,
        "deadline": (datetime.now(UTC) + timedelta(seconds=90)).isoformat().replace("+00:00", "Z"),
        "manifest": {
            "schema_version": 1,
            "run_id": str(uuid4()),
            "mode": "fixture",
            "stage": "validate" if task["split"] == "validation" else "diagnose",
            "task_key": task["task_key"],
            "repeat": 1,
            "task_input_hash": meta["input_hash"],
            "config_hash": digest(harness),
            "dataset_digest": variant["rows_digest"],
            "benchmark_digest": manifest["manifest_digest"],
            "software_revision": "phase2-fixture",
            "evaluator_version": "pending",
            "safety_profile": harness["safety_profile"],
            "worker": FIXTURE_SETTINGS,
            "worker_profile_digest": digest(FIXTURE_SETTINGS),
            "price_profile_digest": digest({"fixture": 0}),
            "schedule_seed": 20251106,
        },
    }


class OrderCountFixture:
    """Scripted fixture for the development order-status scenario."""

    mode = "fixture"
    settings = None
    minimum_output_tokens = 1

    def estimate(self, payload: str) -> int:
        return len(payload.encode()) + len(POLICY.encode()) + 256

    async def turn(self, payload: str, max_output: int) -> Turn:
        data = json.loads(payload)
        recent = data["recent_results"]
        prior = next(
            (
                result["data"]
                for result in reversed(recent)
                if result["status"] == "ok" and result["name"] == "execute_readonly_sql"
            ),
            None,
        )
        if prior is not None:
            ref = {"kind": "cell", "query_id": prior["query_id"], "row": 0, "column": "order_count"}
            calculation = next(
                (
                    r["data"]
                    for r in recent
                    if r["status"] == "ok" and r["name"] == "validate_calculation"
                ),
                None,
            )
            if calculation is not None:
                ref = {"kind": "calculation", "calculation_id": calculation["calculation_id"]}
            elif data["policy_event"] == "verification_required":
                action = tool_call(
                    "validate_calculation",
                    operation="identity",
                    operands=[{"source": ref, "unit": "count"}],
                )
                return Turn({"action": action}, 0, 0)
            action = {
                "kind": "finish",
                "answer": {
                    "kind": "answer",
                    "findings": [
                        {
                            "key": "order_count",
                            "unit": "count",
                            "value": prior["rows"][0][0],
                            "evidence": [ref],
                        }
                    ],
                },
            }
        elif not data["known_tables"]:
            action = tool_call("list_tables")
        else:
            table = next(
                table
                for table in data["known_tables"]
                if table.startswith(("purchases_", "sales_orders_", "transactions_"))
            )
            metadata = next(
                (
                    result["data"]
                    for result in reversed(recent)
                    if result["status"] == "ok" and result["name"] == "describe_schema"
                ),
                None,
            )
            if metadata is None:
                action = tool_call("describe_schema", tables=[table])
            else:
                status_col = next(
                    col["name"]
                    for col in metadata["tables"][0]["columns"]
                    if col["name"] in {"status", "state"}
                )
                prompt = data["task"]["prompt"]
                match = re.search(
                    r"\b(paid|open|cancelled) orders were placed in ([A-Za-z]+ 2025)", prompt
                )
                if match is None:
                    raise ValueError("Unexpected order-status fixture")
                status, period = match.groups()
                month = datetime.strptime(period, "%B %Y").month
                time_col = next(
                    col["name"]
                    for col in metadata["tables"][0]["columns"]
                    if "timestamp" in col["type"]
                )
                lo = f"2025-{month:02d}-01"
                hi = f"{2025 + month // 12}-{month % 12 + 1:02d}-01"
                action = tool_call(
                    "execute_readonly_sql",
                    sql=(
                        f"SELECT count(*) AS order_count FROM {table} "
                        f"WHERE {status_col} = '{status}' AND {time_col} >= '{lo}'::timestamptz "
                        f"AND {time_col} < '{hi}'::timestamptz"
                    ),
                )
        return Turn({"action": action}, 0, 0)


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["config-check", "run"])
    parser.add_argument("--harness", type=Path, default=BASELINE)
    args = parser.parse_args()
    harness = read_harness(args.harness.read_bytes())
    if args.command == "config-check":
        print(harness.content_hash)
        return 0
    manifest = load_json(DEVELOPMENT / "manifest.json")
    entry = next(
        entry
        for entry in load_json(DEVELOPMENT / "prompts.json")
        if entry["task"]["category"] == "efficiency"
    )
    task = entry["task"]
    request = fixture_request(task, harness.config, manifest, entry["fault"])
    dsn = load_json(RUNTIME_MAP)[task["variant_id"]]
    envelope = asyncio.run(execute(request, OrderCountFixture(), dsn, CATALOG))
    print(json_bytes(envelope).decode())
    return int(envelope["result"] != "answered")


if __name__ == "__main__":
    raise SystemExit(main())
