"""Operator-only single-task smoke and full live trial commands."""

import argparse
import json
import os
import re
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from harnesslab_contracts.internal import read_json
from harnesslab_contracts.replay import digest
from harnesslab_contracts.validate import accepts

UNKNOWN = {"usage_mismatch", "model_timeout", "model_error", "task_deadline", "run_interrupted"}


def approved_cap():
    value = os.environ.get("MAX_SPEND_MICRO_USD", "")
    if (
        os.environ.get("HL_LIVE_AUTHORIZED") != "1"
        or not re.fullmatch(r"[1-9][0-9]{0,15}", value)
        or int(value) > 9007199254740991
    ):
        raise ValueError("explicit_live_authorization_and_spend_cap_required")
    return int(value)


def origin(value, *, run_app=False):
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or not url.hostname
        or url.hostname != url.netloc
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
        or run_app
        and not url.hostname.endswith(".run.app")
    ):
        raise ValueError("approved_https_origin_required")
    return value.rstrip("/")


def bill(price, input_tokens, output_tokens):
    return (
        int(price["input"]) * input_tokens + int(price["output"]) * output_tokens + 999999
    ) // 1000000


def smoke_input(source, cap):
    if set(source) != {"execute", "price"} or not isinstance(source["price"], dict):
        raise ValueError("invalid_smoke_input")
    request, price = source["execute"], source["price"]
    request["deadline"] = (
        (datetime.now(UTC) + timedelta(seconds=90)).isoformat().replace("+00:00", "Z")
    )
    if (
        not accepts("ExecuteTaskRequest", request)
        or request["task"]["split"] != "dev"
        or request["manifest"]["mode"] != "live"
        or request["manifest"]["stage"] != "diagnose"
        or request["manifest"]["task_key"] != request["task"]["task_key"]
        or request["manifest"]["task_input_hash"] != digest(request["task"])
        or request["manifest"]["config_hash"] != digest(request["harness"])
        or request["manifest"]["worker_profile_digest"] != digest(request["manifest"]["worker"])
        or request["manifest"]["price_profile_digest"] != digest(price)
        or set(price) != {"input", "output"}
        or not all(
            isinstance(v, str) and re.fullmatch(r"[1-9][0-9]{0,15}", v) for v in price.values()
        )
        or bill(price, 12000, 3000) > cap
    ):
        raise ValueError("invalid_or_over_budget_smoke")
    return request, price


def private_json(path, result, *, new=False):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.stat().st_mode & 0o077:
        raise ValueError("private_result_directory_required")
    with path.open("x" if new else "w") as stream:
        json.dump(result, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    if new:
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def service(client, role, route, payload):
    prefix = "HL_LIVE_" + role.upper()
    url = origin(os.environ[prefix + "_URL"], run_app=True)
    response = client.post(
        url + "/internal/v1/" + route,
        json=payload,
        headers={
            "Authorization": "Bearer " + os.environ[prefix + "_TOKEN"],
            "X-Serverless-Authorization": "Bearer " + os.environ[prefix + "_ID_TOKEN"],
        },
        timeout=100,
    )
    response.raise_for_status()
    return response.json()


def smoke(client, cap, output):
    request, price = smoke_input(read_json(Path(os.environ["HL_LIVE_SMOKE_INPUT"])), cap)
    run_id = request["manifest"]["run_id"]
    reserve = bill(price, 12000, 3000)
    marker = output / f"{run_id}.effect.json"
    # Retain the reservation across an interrupted response and forbid automatic live replay.
    private_json(
        marker, {"run_id": run_id, "state": "reserved", "reserve_microusd": reserve}, new=True
    )
    response = service(client, "runner", "execute-task", request)
    if not accepts("ExecuteTaskResponse", response):
        raise ValueError("invalid_live_worker_response")
    run = response["run"]
    if run["manifest"] != request["manifest"]:
        raise ValueError("smoke_manifest_mismatch")
    uncertain = any(
        event["kind"] == "policy_decision" and event["outcome_code"] in UNKNOWN
        for event in run["events"]
    )
    usage = [event["payload"] for event in run["events"] if event["kind"] == "model_usage"]
    charged = bill(
        price, sum(x["input_tokens"] for x in usage), sum(x["output_tokens"] for x in usage)
    )
    if uncertain or charged > reserve or run["result"] == "infrastructure_error":
        raise ValueError("ambiguous_live_effect_reservation_retained")
    evaluated = service(client, "evaluator", "grade-task", {"schema_version": 1, "run": run})
    if not accepts("GradeTaskResponse", evaluated):
        raise ValueError("invalid_live_grade")
    path = output / f"{run_id}.result.json"
    private_json(
        path,
        {
            "mode": "live",
            "run_id": run_id,
            "spent_microusd": charged,
            "trace_digest": run["trace_digest"],
            "grade": evaluated["grade"],
            "worker_snapshot": run["manifest"]["worker"]["snapshot"],
        },
        new=True,
    )
    print(f"Private live smoke result saved to {path}")


def trial(client, cap, output):
    site = origin(os.environ["BASE_URL"])
    key = os.environ.get("HL_LIVE_IDEMPOTENCY_KEY", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", key):
        raise ValueError("fixed_operator_idempotency_key_required")
    headers = {"Authorization": "Bearer " + os.environ["HL_OPERATOR_ACCESS_TOKEN"], "Origin": site}
    reply = client.post(
        site + "/api/v1/experiments",
        headers={**headers, "Idempotency-Key": key},
        json={"scope": "full_live", "max_spend_microusd": cap},
    )
    reply.raise_for_status()
    result = reply.json()
    if not accepts("ExperimentAccepted", result):
        raise ValueError("invalid_live_trial_response")
    path = site + "/api/v1/experiments/" + result["id"]
    deadline = time.monotonic() + 18 * 3600
    print(f"Live experiment {result['id']}", flush=True)
    while time.monotonic() < deadline:
        response = client.get(path, headers=headers)
        response.raise_for_status()
        detail = response.json()
        if not accepts("ExperimentDetail", detail) or detail["experiment"]["mode"] != "live":
            raise ValueError("invalid_live_trial_detail")
        if detail["experiment"]["status"] not in {"queued", "running"}:
            report = client.get(path + "/comparisons", headers=headers)
            report.raise_for_status()
            if not accepts("ExperimentComparisons", report.json()):
                raise ValueError("invalid_live_trial_comparisons")
            destination = output / f"{result['id']}.trial.json"
            private_json(
                destination, {"experiment": detail["experiment"], "comparisons": report.json()}
            )
            print(f"Private live comparison saved to {destination}")
            return
        time.sleep(10)
    raise ValueError("live_trial_poll_limit_resume_with_same_key")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("smoke", "trial"))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        cap = approved_cap()
        directory = Path(os.environ["HL_LIVE_RESULTS_DIR"])
        if not directory.is_absolute():
            raise ValueError("absolute_private_result_directory_required")
        with httpx.Client(timeout=15, trust_env=False, follow_redirects=False) as client:
            (smoke if args.command == "smoke" else trial)(client, cap, directory)
    except (httpx.HTTPError, OSError, ValueError, KeyError, TypeError) as error:
        value = str(error)
        code = (
            value
            if isinstance(error, ValueError) and re.fullmatch("[a-z0-9_]+", value)
            else type(error).__name__
        )
        raise SystemExit(f"Live check stopped ({code})") from None


if __name__ == "__main__":
    main()
