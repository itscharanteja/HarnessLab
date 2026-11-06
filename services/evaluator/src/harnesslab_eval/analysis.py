from collections import defaultdict

from harnesslab_contracts.validate import accepts

SQL = "execute_readonly_sql"
INVALID_SQL = {
    "schema_error",
    "missing_relation",
    "syntax_error",
    "invalid_sql",
    "malformed_sql_action",
}
EVIDENCE_GAPS = {
    "unsupported_evidence",
    "verification_failed",
    "verification_required",
    "invalid_evidence",
}


def analyze_dev(runs):
    if not accepts("AnalyzeDevRequest", {"schema_version": 1, "runs": runs}):
        raise ValueError("invalid diagnosis")
    ordered = sorted(runs, key=lambda item: item["task_key"])
    keys = [run["task_key"] for run in ordered]
    if (
        len(set(keys)) != len(keys)
        or len({run["run_id"] for run in ordered}) != len(runs)
        or any(key.split("/")[1] != "dev" for key in keys)
    ):
        raise ValueError("invalid diagnosis sample")
    affected = defaultdict(list)
    counterexamples = []
    metrics = dict.fromkeys(
        (
            "successes",
            "tool_calls",
            "cost_micros",
            "invalid_sql",
            "sql_calls",
            "faults",
            "recoveries",
        ),
        0,
    )
    for run in ordered:
        ref = lambda seq, run_id=run["run_id"]: {"run_id": run_id, "seq": seq}  # noqa: E731
        first = {}
        metadata = False
        fault = None
        recovery = False
        events = run["events"]
        if [item["seq"] for item in events] != sorted({item["seq"] for item in events}):
            raise ValueError("invalid diagnosis event order")
        metrics["successes"] += run["success"]
        metrics["tool_calls"] += run["tool_calls"]
        metrics["cost_micros"] += run["cost_micros"]
        for event in events:
            kind, code, tool, seq = (event[k] for k in ("kind", "code", "tool", "seq"))
            if kind == "tool_request" and tool == SQL:
                metrics["sql_calls"] += 1
            if kind == "tool_result":
                if tool == SQL and code in INVALID_SQL:
                    metrics["invalid_sql"] += 1
                    if not metadata and code in {"schema_error", "missing_relation"}:
                        first.setdefault("schema_before_discovery", seq)
                if tool in {"list_tables", "describe_schema"} and code == "ok":
                    metadata = True
            if kind == "policy_decision" and code == "repeated_failed_sql":
                first.setdefault("blocked_repeat", seq)
            if code in EVIDENCE_GAPS:
                first.setdefault("evidence_gap", seq)
            if kind == "fault":
                fault = seq
            if kind == "recovery" and fault is not None and tool == SQL:
                recovery = True
        if fault is not None:
            metrics["faults"] += 1
            if recovery and run["success"]:
                metrics["recoveries"] += 1
            else:
                first["unrecovered_fault"] = fault
        if events and "unsupported_evidence" in run["reasons"]:
            first.setdefault("evidence_gap", events[-1]["seq"])
        if events and run["success"] and run["task_key"].split("/")[3] == "efficiency":
            if run["tool_calls"] > 4:
                first["excess_efficiency_calls"] = events[-1]["seq"]
            elif not first and len(counterexamples) < 3:
                counterexamples.append(ref(events[-1]["seq"]))
        for signature, seq in first.items():
            affected[signature].append(ref(seq))
    clusters = [
        {"signature": signature, "count": len(refs), "evidence_refs": refs[:3]}
        for signature, refs in sorted(affected.items(), key=lambda item: (-len(item[1]), item[0]))
        if len(refs) >= 2
    ]
    return {
        "schema_version": 1,
        "clusters": clusters[:5],
        "counterexamples": counterexamples,
        "metrics": {"scheduled": len(ordered), **metrics},
    }
