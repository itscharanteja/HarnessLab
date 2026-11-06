"""Offline operator entry point. Never imported by the HTTP services."""

import argparse
import asyncio
import fcntl
import json
import os
import re
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid5

from harnesslab_contracts.internal import read_json
from harnesslab_contracts.replay import digest
from harnesslab_contracts.validate import accepts
from harnesslab_eval.comparison import CATEGORIES, compare
from harnesslab_eval.grader import VERSION, grade_run
from harnesslab_runner.config import read_harness
from harnesslab_runner.fixture import BASELINE, CATALOG, FIXTURE_SETTINGS, OrderCountFixture
from harnesslab_runner.graph import execute, tool_call
from harnesslab_runner.model import OpenAITurns, Turn
from harnesslab_runner.trial_fixture import INVOICES, choose, column, dates, in_period
from psycopg.conninfo import conninfo_to_dict

FIXTURE = Path(".artifacts/benchmark-fixture")
SEED = 20251106
UNKNOWN = {
    "usage_mismatch",
    "model_timeout",
    "model_error",
    "task_deadline",
    "run_interrupted",
}
INVALID_SQL = {
    "schema_error",
    "missing_relation",
    "syntax_error",
    "invalid_sql",
    "malformed_sql_action",
    "sql_policy",
    "sql_too_large",
}
SQL = "execute_readonly_sql"
NAMESPACE = UUID("a630c25b-f44d-4799-94b3-49dafb61c058")


def json_text(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def cost(price, input_tokens, output_tokens):
    return (
        int(price["input"]) * input_tokens + int(price["output"]) * output_tokens + 999999
    ) // 1000000


class HoldoutFixture(OrderCountFixture):
    async def turn(self, payload, max_output):
        data = json.loads(payload)
        task = data["task"]
        category = task["category"]
        results = {entry["name"]: entry for entry in data["recent_results"]}
        answer = {"kind": "unable", "reason": "fixture_scope"}
        if category == "ambiguous_requests":
            answer = {
                "kind": "clarify",
                "missing_fields": ["metric_basis"],
                "question": "Which sales metric should I use?",
            }
        elif category in {"efficiency", "tool_failures"}:
            if not data["known_tables"]:
                return Turn({"action": tool_call("list_tables")}, 0, 0)
            invoice = choose(data["known_tables"], INVOICES)
            if category == "tool_failures" and SQL not in results:
                return Turn({"action": tool_call(SQL, sql=f"SELECT count(*) FROM {invoice}")}, 0, 0)
            if category == "efficiency":
                orders = choose(
                    data["known_tables"], ("purchases_", "sales_orders_", "transactions_")
                )
                if "describe_schema" not in results:
                    return Turn(
                        {"action": tool_call("describe_schema", tables=[invoice, orders])}, 0, 0
                    )
                tables = {
                    entry["name"]: entry for entry in results["describe_schema"]["data"]["tables"]
                }
                fk = next(
                    (
                        col["name"]
                        for col in tables[invoice]["columns"]
                        if col["name"] in {"order_id", "purchase_key"}
                    ),
                    None,
                )
                try:
                    order_id = column(tables[orders], "id", "key")
                    placed = column(tables[orders], "ordered_at", "purchased_on")
                except StopIteration:
                    fk = None
                if SQL not in results and fk:
                    lo, hi = dates(task["prompt"].replace(" in ", " during "))
                    query = (
                        f"SELECT count(*) AS invoice_count FROM {invoice} i JOIN {orders} o "
                        f"ON i.{fk}=o.{order_id} WHERE {in_period(f'o.{placed}', lo, hi)}"
                    )
                    return Turn({"action": tool_call(SQL, sql=query)}, 0, 0)
                if SQL in results and results[SQL]["status"] == "ok":
                    result = results[SQL]["data"]
                    answer = {
                        "kind": "answer",
                        "findings": [
                            {
                                "key": "invoice_count",
                                "unit": "count",
                                "value": result["rows"][0][0],
                                "evidence": [
                                    {
                                        "kind": "cell",
                                        "query_id": result["query_id"],
                                        "row": 0,
                                        "column": "invoice_count",
                                    }
                                ],
                            }
                        ],
                    }
        return Turn({"action": {"kind": "finish", "answer": answer}}, 0, 0)


def check_manifest(manifest, approved_digest, fixture):
    if (
        manifest["manifest_digest"] != approved_digest
        or digest({key: value for key, value in manifest.items() if key != "manifest_digest"})
        != approved_digest
        or manifest["split"] != "holdout"
        or manifest["fixture"] is not fixture
        or len(manifest["tasks"]) != 30
    ):
        raise ValueError("holdout_manifest_mismatch")
    keys = [task["id"] for task in manifest["tasks"]]
    if len(set(keys)) != 30 or any(
        not accepts("TaskKey", key) or key.split("/")[1] != "holdout" for key in keys
    ):
        raise ValueError("holdout_roster_mismatch")
    return keys


def load_bundle(directory, manifest):
    prompts = read_json(directory / "prompts.json")
    oracles = read_json(directory / "oracles.json")
    if (
        digest(oracles) != manifest["reference_bundle_digest"]
        or len(prompts) != 30
        or len(oracles) != 30
    ):
        raise ValueError("holdout_bundle_mismatch")
    entries = {item["task"]["task_key"]: item for item in prompts}
    refs = {item["task_key"]: item for item in oracles}
    tasks = {}
    counts = dict.fromkeys(CATEGORIES, 0)
    variants = {row["id"]: row["rows_digest"] for row in manifest["variants"]}
    for meta in manifest["tasks"]:
        key = meta["id"]
        item = entries[key]
        task, fault = item["task"], item["fault"]
        if (
            key in tasks
            or not accepts("TaskInput", task)
            or task["split"] != "holdout"
            or key.split("/")[1:4] != ["holdout", task["variant_id"], task["category"]]
            or meta["variant_id"] != task["variant_id"]
            or meta["category"] != task["category"]
            or meta["split"] != "holdout"
            or digest(task) != meta["input_hash"]
            or meta["input_hash"] != refs[key]["input_hash"]
            or digest(fault) != meta["fault_digest"]
            or bool(fault) != (task["category"] == "tool_failures")
            or fault
            and not accepts("FaultFixture", fault)
            or task["variant_id"] not in variants
        ):
            raise ValueError("holdout_task_mismatch")
        tasks[key] = (task, fault, refs[key], meta["input_hash"], variants[task["variant_id"]])
        counts[task["category"]] += 1
    if (
        counts != CATEGORIES
        or len(variants) != 3
        or {row[0]["variant_id"] for row in tasks.values()} != set(variants)
    ):
        raise ValueError("holdout_roster_mismatch")
    return tasks


def open_ledger(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise ValueError("private_ledger_directory_required")
    db = sqlite3.connect(directory / "holdout.sqlite3")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
      CREATE TABLE IF NOT EXISTS evaluations (
        digest TEXT PRIMARY KEY, seal TEXT NOT NULL, report TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        digest TEXT NOT NULL REFERENCES evaluations(digest), run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running','received','done')),
        deadline TEXT NOT NULL, envelope TEXT, result TEXT, charged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(digest,run_id)
      );
    """)
    return db


def seal_evaluation(db, manifest_digest, seal):
    with db:
        db.execute(
            "INSERT OR IGNORE INTO evaluations VALUES (?,?,NULL)",
            (manifest_digest, json_text(seal)),
        )
        existing, report = db.execute(
            "SELECT seal,report FROM evaluations WHERE digest=?", (manifest_digest,)
        ).fetchone()
        if existing != json_text(seal):
            raise ValueError("holdout_already_sealed")
    return json.loads(report) if report else None


def failed(run_id, charged):
    return {
        "run_id": run_id,
        "trace_digest": None,
        "complete": False,
        "success": False,
        "latency_ms": 0,
        "tool_calls": 0,
        "worker_cost_microusd": charged,
        "invalid_sql_attempts": 0,
        "sql_attempts": 0,
        "recovered": False,
        "safety_violations": 0,
    }


def metrics(envelope, grade, charge, recoverable):
    events = envelope["events"]
    calls, sql, invalid = set(), set(), set()
    safety, encountered, recovered = 0, False, False
    for event in events:
        kind, code, correlation, payload = (
            event["kind"],
            event["outcome_code"],
            event["correlation_id"],
            event["payload"],
        )
        tool = payload.get("call", {}).get("name") or payload.get("name") or payload.get("tool")
        if (
            correlation
            and correlation.startswith("call_")
            and kind in {"tool_request", "policy_decision"}
        ):
            calls.add(correlation)
        if kind == "policy_decision":
            safety += payload["safety_violation"]
        if kind == "fault" and tool == SQL:
            encountered = True
        if kind == "tool_result" and tool == SQL and code == "ok" and encountered:
            recovered = True
        if correlation and kind == "tool_request" and tool == SQL:
            sql.add(correlation)
        if (
            correlation
            and code in INVALID_SQL
            and (
                kind == "tool_result"
                and tool == SQL
                or kind == "policy_decision"
                and code in {"malformed_sql_action", "sql_too_large"}
            )
        ):
            sql.add(correlation)
            invalid.add(correlation)
    return {
        "run_id": envelope["manifest"]["run_id"],
        "trace_digest": envelope["trace_digest"],
        "complete": envelope["result"] != "infrastructure_error",
        "success": grade["grade"]["success"],
        "latency_ms": events[-1]["elapsed_ms"],
        "tool_calls": len(calls),
        "worker_cost_microusd": charge,
        "invalid_sql_attempts": len(invalid),
        "sql_attempts": len(sql),
        "recovered": recoverable and recovered and grade["grade"]["success"],
        "safety_violations": safety,
    }


async def evaluate_run(db, pin, request, oracle, dsn, key):
    run_id = request["manifest"]["run_id"]
    match = (pin["manifest_digest"], run_id)
    row = db.execute(
        "SELECT state,deadline,envelope,result FROM runs WHERE digest=? AND run_id=?", match
    ).fetchone()
    if row and row[0] == "done":
        return json.loads(row[3])
    paid = pin["mode"] == "live"
    reserve = cost(pin["price"], 12000, 3000)
    result = None
    if row and row[0] == "received":
        envelope = json.loads(row[2])
    elif row and paid:
        result = failed(run_id, reserve)
    else:
        deadline = row[1] if row else (datetime.now(UTC) + timedelta(seconds=90)).isoformat()
        if not row:
            with db:
                db.execute(
                    "INSERT INTO runs(digest,run_id,state,deadline) VALUES(?,?,'running',?)",
                    (*match, deadline),
                )
        request["deadline"] = deadline.replace("+00:00", "Z")
        try:
            if paid:
                async with OpenAITurns(pin["worker"], key) as turns:
                    envelope = await execute(request, turns, dsn, CATALOG, operator_holdout=True)
            else:
                envelope = await execute(
                    request, HoldoutFixture(), dsn, CATALOG, operator_holdout=True
                )
        except (OSError, ValueError, RuntimeError):
            result = failed(run_id, reserve if paid else 0)
        if result is None:
            with db:
                db.execute(
                    "UPDATE runs SET state='received',envelope=? WHERE digest=? AND run_id=?",
                    (json_text(envelope), *match),
                )
    if result is None:
        events = envelope["events"]
        usage = [event["payload"] for event in events if event["kind"] == "model_usage"]
        charge = cost(
            pin["price"],
            sum(row["input_tokens"] for row in usage),
            sum(row["output_tokens"] for row in usage),
        )
        if paid and any(
            event["kind"] == "policy_decision" and event["outcome_code"] in UNKNOWN
            for event in events
        ):
            result = failed(run_id, reserve)
        else:
            try:
                grade = grade_run(envelope, oracle)
                result = metrics(envelope, grade, charge, bool(request["fault"]))
            except (ValueError, ArithmeticError):
                result = failed(run_id, charge)
    with db:
        db.execute(
            "UPDATE runs SET state='done',result=?,charged=? WHERE digest=? AND run_id=?",
            (json_text(result), result["worker_cost_microusd"], *match),
        )
    return result


def matched_roster(pin, task_keys):
    roster = []
    for task_key in sorted(task_keys):
        for repeat in range(1, 4):
            for side in sorted(
                ("baseline", "candidate"),
                key=lambda arm: digest([SEED, task_key, repeat, pin[arm]]),
            ):
                run_id = str(uuid5(NAMESPACE, digest([pin, task_key, repeat, side])))
                roster.append((task_key, repeat, side, run_id))
    return roster


async def run_evaluation(db, pin, roster, tasks, runtimes, configs, key):
    evaluations = []
    by_cell = {}
    for task_key, repeat, side, run_id in roster:
        task, fault, oracle, input_hash, dataset_digest = tasks[task_key]
        request = {
            "schema_version": 1,
            "task": task,
            "fault": fault,
            "harness": configs[side],
            "manifest": {
                "schema_version": 1,
                "run_id": run_id,
                "mode": pin["mode"],
                "stage": "validate",
                "task_key": task_key,
                "repeat": repeat,
                "task_input_hash": input_hash,
                "config_hash": pin[side],
                "dataset_digest": dataset_digest,
                "benchmark_digest": pin["manifest_digest"],
                "software_revision": "holdout-v1",
                "evaluator_version": VERSION,
                "safety_profile": "readonly-synthetic-v1",
                "worker": pin["worker"],
                "worker_profile_digest": digest(pin["worker"]),
                "price_profile_digest": digest(pin["price"]),
                "schedule_seed": SEED,
            },
        }
        cell = by_cell.setdefault(
            (task_key, repeat),
            {
                "task_key": task_key,
                "category": task["category"],
                "repeat": repeat,
                "recoverable_fault": bool(fault),
            },
        )
        cell[side] = await evaluate_run(db, pin, request, oracle, runtimes[task["variant_id"]], key)
        evaluations.append(cell[side])
    report = compare(
        {
            "schema_version": 1,
            "experiment_id": str(uuid5(NAMESPACE, digest(pin))),
            "baseline_hash": pin["baseline"],
            "candidate_hash": pin["candidate"],
            "scope": "holdout",
            "mode": pin["mode"],
            "manifest_digest": digest(pin),
            "roster_digest": pin["roster_digest"],
            "provenance_valid": all(run["complete"] for run in evaluations),
            "candidate_dev_safe": False,
            "seed": SEED,
            "cells": list(by_cell.values()),
        }
    )
    aggregate = {
        "schema_version": 1,
        "release_id": pin["release_id"],
        "benchmark_digest": pin["manifest_digest"],
        "comparison": report,
        "worker_spend_microusd": sum(run["worker_cost_microusd"] for run in evaluations),
        "spend_cap_microusd": pin["cap"],
    }
    with db:
        db.execute(
            "UPDATE evaluations SET report=? WHERE digest=?",
            (json_text(aggregate), pin["manifest_digest"]),
        )
    return aggregate


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("fixture", "release"), required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--manifest-digest")
    parser.add_argument("--release-id")
    parser.add_argument("--spend-cap", type=int)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--runtime-map", type=Path)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--worker-profile", type=Path)
    parser.add_argument("--price-profile", type=Path)
    args = parser.parse_args()
    fixture = args.mode == "fixture"
    if not fixture and (
        any(
            getattr(args, name) is None
            for name in (
                "baseline",
                "candidate",
                "manifest_digest",
                "release_id",
                "spend_cap",
                "bundle",
                "runtime_map",
                "work_dir",
                "worker_profile",
                "price_profile",
            )
        )
        or not os.environ.get("HL_HOLDOUT_API_KEY")
        or not os.environ.get("HL_HOLDOUT_SANDBOX_DATABASE")
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", os.environ.get("HL_HOLDOUT_IMAGE_DIGEST", ""))
    ):
        parser.error(
            "Release requires an explicit sealed pair, private bundle, sandbox, ledger "
            "and approved profiles"
        )
    os.umask(0o077)
    try:
        return run(args, fixture)
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, BlockingIOError) as exc:
        raise SystemExit(f"Holdout stopped ({type(exc).__name__})") from None


async def check_worker(settings, key):
    async with OpenAITurns(settings, key):
        pass


def run(args, fixture):
    directory = args.bundle or FIXTURE / "holdout"
    runtime_file = args.runtime_map or FIXTURE / ".runtime/holdout.json"
    work = args.work_dir or Path(".artifacts/holdout-operator")
    if not fixture and (
        not directory.is_absolute()
        or not runtime_file.is_absolute()
        or not work.is_absolute()
        or directory.stat().st_mode & 0o077
        or runtime_file.stat().st_mode & 0o077
    ):
        raise ValueError("private_holdout_paths_required")
    manifest = read_json(directory / "manifest.json")
    approved = args.manifest_digest or manifest["manifest_digest"]
    baseline_bytes = (args.baseline or BASELINE).read_bytes()
    candidate_bytes = (
        args.candidate.read_bytes()
        if args.candidate
        else baseline_bytes.replace(
            b"schema_inspection: on_error", b"schema_inspection: before_first_sql"
        )
    )
    baseline, candidate = read_harness(baseline_bytes), read_harness(candidate_bytes)
    release = args.release_id or "fixture-holdout-v1"
    cap = args.spend_cap if args.spend_cap is not None else 0
    settings = read_json(args.worker_profile) if args.worker_profile else FIXTURE_SETTINGS
    price = read_json(args.price_profile) if args.price_profile else {"input": "0", "output": "0"}
    if (
        baseline.content_hash == candidate.content_hash
        or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", release)
        or not accepts("Digest", approved)
        or not accepts("ModelSettings", settings)
        or not isinstance(price, dict)
        or set(price) != {"input", "output"}
        or not all(
            isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value)
            for value in price.values()
        )
        or not 0 <= cap <= 9007199254740991
        or fixture
        and (cap != 0 or any(map(int, price.values())) or settings != FIXTURE_SETTINGS)
        or not fixture
        and (not cap or not all(map(int, price.values())))
        or cost(price, 12000, 3000) * 180 > cap
    ):
        raise ValueError("invalid_holdout_plan")
    pin = {
        "release_id": release,
        "manifest_digest": approved,
        "baseline": baseline.content_hash,
        "candidate": candidate.content_hash,
        "worker": settings,
        "price": price,
        "cap": cap,
        "mode": "fixture" if fixture else "live",
        "seed": SEED,
    }
    runtimes = read_json(runtime_file)
    database = "harnesslab_holdout" if fixture else os.environ["HL_HOLDOUT_SANDBOX_DATABASE"]
    if database in {"harnesslab_control", "harnesslab_sandbox"}:
        raise ValueError("isolated_sandbox_required")
    key = os.environ.get("HL_HOLDOUT_API_KEY")
    if not fixture:
        pin["image_digest"] = os.environ["HL_HOLDOUT_IMAGE_DIGEST"]
        pin["sandbox_database"] = database
        asyncio.run(check_worker(settings, key))
    roster = matched_roster(pin, check_manifest(manifest, approved, fixture))
    pin["roster_digest"] = digest(roster)
    for dsn in runtimes.values():
        parsed = conninfo_to_dict(dsn)
        if (
            parsed.get("dbname") != database
            or fixture
            and (
                parsed.get("host") not in {"127.0.0.1", "localhost"}
                or parsed.get("port") != os.environ.get("HOLDOUT_DB_PORT", "55434")
            )
        ):
            raise ValueError("isolated_sandbox_required")
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    if work.stat().st_mode & 0o077:
        raise ValueError("private_ledger_directory_required")
    with (work / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = open_ledger(work)
        try:
            # Persist the matched roster commitment before opening prompts or oracles.
            report = seal_evaluation(db, approved, pin)
            if report is None:
                tasks = load_bundle(directory, manifest)
                if set(runtimes) != {task[0]["variant_id"] for task in tasks.values()}:
                    raise ValueError("isolated_sandbox_map_mismatch")
                report = asyncio.run(
                    run_evaluation(
                        db,
                        pin,
                        roster,
                        tasks,
                        runtimes,
                        {"baseline": baseline.config, "candidate": candidate.config},
                        key,
                    )
                )
            output = work / f"{approved}.aggregate.json"
            staging = work / f".{approved}.aggregate.tmp"
            staging.write_text(json_text(report) + "\n")
            staging.replace(output)
        finally:
            db.close()
    print(f"Private holdout report saved to {output}")
    return 0 if report["comparison"]["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
