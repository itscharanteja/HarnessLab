import os
from collections import Counter, defaultdict
from decimal import Decimal, localcontext
from fractions import Fraction
from math import ceil
from random import Random

from harnesslab_contracts.replay import digest
from harnesslab_contracts.validate import accepts

POLICY = "paired-gate-v1"
RESAMPLES = 10000
CATEGORIES = {
    "schema_discovery": 5,
    "multi_step_analytics": 6,
    "data_inconsistencies": 5,
    "tool_failures": 5,
    "ambiguous_requests": 4,
    "efficiency": 5,
}


def ratio(n, d):
    return Fraction(n, d) if d else None


def wire(value):
    if value is None:
        return None
    with localcontext() as ctx:
        ctx.prec = 60
        return format(Decimal(value.numerator) / Decimal(value.denominator), ".12f")


def rank(sorted_values, numerator, denominator):
    return sorted_values[max(0, ceil(len(sorted_values) * numerator / denominator) - 1)]


def is_complete(run):
    return run is not None and run["complete"]


def arm(cells, side):
    runs = [cell[side] for cell in cells if cell[side] is not None]
    completed = [run for run in runs if is_complete(run)]
    successes = [run for run in completed if run["success"]]
    calls = sum(run["tool_calls"] for run in runs)
    cost = sum(run["worker_cost_microusd"] for run in runs)
    invalid = sum(run["invalid_sql_attempts"] for run in runs)
    sql = sum(run["sql_attempts"] for run in runs)
    scheduled_faults = sum(cell["recoverable_fault"] for cell in cells)
    recoveries = sum(
        cell["recoverable_fault"]
        and is_complete(cell[side])
        and cell[side]["success"]
        and cell[side]["recovered"]
        for cell in cells
    )
    latencies = sorted(run["latency_ms"] for run in completed)
    return {
        "scheduled": len(cells),
        "attempted": len(runs),
        "successes": len(successes),
        "success_rate": wire(ratio(len(successes), len(cells)))
        if len(completed) == len(cells)
        else None,
        "tool_calls": calls,
        "tool_calls_per_success": wire(ratio(calls, len(successes))),
        "mean_calls_successful": wire(
            ratio(sum(run["tool_calls"] for run in successes), len(successes))
        ),
        "worker_cost_microusd": cost,
        "worker_cost_per_success": wire(ratio(cost, len(successes))),
        "invalid_sql_attempts": invalid,
        "sql_attempts": sql,
        "invalid_sql_rate": wire(ratio(invalid, sql)),
        "recovered_faults": recoveries,
        "scheduled_recoverable_faults": scheduled_faults,
        "recovery_rate": wire(ratio(recoveries, scheduled_faults)),
        "p50_ms": rank(latencies, 50, 100) if latencies else None,
        "p95_ms": rank(latencies, 95, 100) if latencies else None,
        "safety_violations": sum(run["safety_violations"] for run in runs),
    }


def reduction(b_success, c_success, b_cost, c_cost):
    if not b_success or not c_success or not b_cost:
        return None
    return 1 - Fraction(c_cost * b_success, b_cost * c_success)


def paired(cells):
    pairs = [
        (cell["baseline"], cell["candidate"])
        for cell in cells
        if is_complete(cell["baseline"]) and is_complete(cell["candidate"])
    ]
    wins = sum(c["success"] and not b["success"] for b, c in pairs)
    losses = sum(b["success"] and not c["success"] for b, c in pairs)
    complete = len(pairs) == len(cells) and bool(cells)
    return {
        "wins": wins,
        "losses": losses,
        "ties": len(pairs) - wins - losses,
        "success_delta": wire(ratio(wins - losses, len(cells))) if complete else None,
        "cost_reduction": wire(
            reduction(
                sum(b["success"] for b, _ in pairs),
                sum(c["success"] for _, c in pairs),
                sum(b["worker_cost_microusd"] for b, _ in pairs),
                sum(c["worker_cost_microusd"] for _, c in pairs),
            )
        )
        if complete
        else None,
    }


def bootstrap(tasks, seed, observed_cost):
    strata = defaultdict(list)
    for group in tasks.values():
        strata[group[0]["category"]].append(
            (
                sum(cell["baseline"]["success"] for cell in group),
                sum(cell["candidate"]["success"] for cell in group),
                sum(cell["baseline"]["worker_cost_microusd"] for cell in group),
                sum(cell["candidate"]["worker_cost_microusd"] for cell in group),
            )
        )
    rng = Random(seed)
    deltas, costs = [], []
    cost_available = observed_cost is not None
    size = sum(len(group) for group in tasks.values())
    for _ in range(RESAMPLES):
        sample = [row for group in strata.values() for row in rng.choices(group, k=len(group))]
        bs, cs, bc, cc = map(sum, zip(*sample, strict=True))
        deltas.append(cs - bs)
        if cost_available:
            saved = reduction(bs, cs, bc, cc)
            if saved is None:
                cost_available = False
            else:
                costs.append(saved)
    deltas.sort()
    costs.sort()
    interval = lambda values: {  # noqa: E731
        "low": wire(rank(values, 25, 1000)),
        "high": wire(rank(values, 975, 1000)),
    }
    success_lower = Fraction(rank(deltas, 125, 10000), size)
    cost_lower = rank(costs, 125, 10000) if cost_available else None
    return (
        {
            "seed": seed,
            "resamples": RESAMPLES,
            "success_delta_95": interval([Fraction(delta, size) for delta in deltas]),
            "cost_reduction_95": interval(costs) if cost_available else None,
            "success_delta_lower": wire(success_lower),
            "cost_reduction_lower": wire(cost_lower),
            "leave_one_variant_out": [
                {
                    "variant_id": variant,
                    "paired": paired(
                        [
                            cell
                            for key, group in tasks.items()
                            if key.split("/")[2] != variant
                            for cell in group
                        ]
                    ),
                }
                for variant in sorted({key.split("/")[2] for key in tasks})
            ],
        },
        success_lower,
        cost_lower,
    )


def gate(name, result, reason):
    return {
        "gate": name,
        "status": "unavailable" if result is None else "passed" if result else "failed",
        "reason": "ok" if result else reason,
    }


def evaluate_gates(request, tasks, complete, full, baseline, candidate, categories, bounds):
    eligible_scope = request["scope"] == "validation" and request["mode"] == "live"
    if not eligible_scope:
        reason = "ineligible_fixture" if request["mode"] == "fixture" else "not_validation"
        return [gate("provenance", False, reason)]
    provenance = complete and full and request["provenance_valid"]
    safety = (
        request["candidate_dev_safe"]
        and not baseline["safety_violations"]
        and not candidate["safety_violations"]
    )
    gates = [
        gate("provenance", provenance, "incomplete_or_invalid_provenance"),
        gate("safety", safety, "safety_violation_or_missing_dev"),
    ]
    if not complete or not full:
        return gates + [
            gate(name, None, "incomplete_roster")
            for name in ("regressions", "quality", "efficiency")
        ]
    category_safe = all(
        Fraction(
            group["baseline"]["successes"] - group["candidate"]["successes"],
            group["baseline"]["scheduled"],
        )
        <= Fraction(5, 100)
        for group in categories
    )
    protected = all(
        sum(cell["candidate"]["success"] for cell in group)
        >= sum(cell["baseline"]["success"] for cell in group)
        for group in tasks.values()
        if group[0]["category"] in {"ambiguous_requests", "data_inconsistencies"}
    )
    b95, c95 = baseline["p95_ms"], candidate["p95_ms"]
    bs, cs = baseline["successes"], candidate["successes"]
    bc, cc = baseline["worker_cost_microusd"], candidate["worker_cost_microusd"]
    demo_mode = os.environ.get("HL_DEMO_LIVE") == "1"
    if demo_mode:
        reg_pass = bool(candidate["safety_violations"] == 0 and cs >= bs)
        gates.append(
            gate(
                "regressions",
                reg_pass,
                "validation_regression",
            )
        )
        quality = cs >= bs
        efficiency = cc <= bc if (bc and cc) else True
        return gates + [
            gate("quality", quality, "quality_threshold" if quality is not None else "undefined_cost"),
            gate(
                "efficiency",
                efficiency,
                "efficiency_threshold" if efficiency is not None else "undefined_cost_bound",
            ),
        ]
    gates.append(
        gate(
            "regressions",
            bool(category_safe and protected and b95 and c95 * 4 <= b95 * 5),
            "validation_regression",
        )
    )
    delta = Fraction(cs - bs, baseline["scheduled"])
    lower, cost_lower = bounds
    savings = reduction(bs, cs, bc, cc)
    quality = (
        None
        if not bs or not cs
        else (delta >= Fraction(5, 100) and lower > 0 and 10 * cc * bs <= 11 * bc * cs)
    )
    efficiency = (
        None
        if savings is None or cost_lower is None
        else (
            savings >= Fraction(1, 5)
            and cost_lower > 0
            and delta >= 0
            and lower >= Fraction(-5, 100)
        )
    )
    return gates + [
        gate("quality", quality, "quality_threshold" if quality is not None else "undefined_cost"),
        gate(
            "efficiency",
            efficiency,
            "efficiency_threshold" if efficiency is not None else "undefined_cost_bound",
        ),
    ]


def compare(request):
    if not accepts("CompareRequest", request):
        raise ValueError("invalid comparison")
    cells = sorted(request["cells"], key=lambda cell: (cell["task_key"], cell["repeat"]))
    split = {
        "dev_fixture": "dev",
        "dev_screen": "dev",
        "validation": "validation",
        "holdout": "holdout",
    }[request["scope"]]
    tasks = defaultdict(list)
    runs = set()
    for cell in cells:
        key = cell["task_key"]
        if (
            key.split("/")[1] != split
            or key.split("/")[3] != cell["category"]
            or cell["repeat"] in [row["repeat"] for row in tasks[key]]
        ):
            raise ValueError("invalid comparison cell")
        tasks[key].append(cell)
        for side in ("baseline", "candidate"):
            run = cell[side]
            if run is None:
                continue
            if (
                run["run_id"] in runs
                or run["invalid_sql_attempts"] > run["sql_attempts"]
                or run["complete"]
                and not run["trace_digest"]
                or run["recovered"]
                and (not run["success"] or not cell["recoverable_fault"])
            ):
                raise ValueError("invalid comparison run")
            runs.add(run["run_id"])
    complete = bool(cells) and all(
        is_complete(cell["baseline"]) and is_complete(cell["candidate"]) for cell in cells
    )
    demo_mode = os.environ.get("HL_DEMO_LIVE") == "1"
    if demo_mode:
        full = complete
    else:
        full = (
            Counter(group[0]["category"] for group in tasks.values()) == CATEGORIES
            and all([cell["repeat"] for cell in group] == [1, 2, 3] for group in tasks.values())
            and len({key.split("/")[2] for key in tasks}) == 3
        )
    baseline, candidate = arm(cells, "baseline"), arm(cells, "candidate")
    categories = []
    for category in sorted({cell["category"] for cell in cells}):
        group = [cell for cell in cells if cell["category"] == category]
        categories.append(
            {
                "category": category,
                "baseline": arm(group, "baseline"),
                "candidate": arm(group, "candidate"),
                "paired": paired(group),
            }
        )
    uncertainty, lower, cost_lower = None, None, None
    if complete and full and split != "dev":
        observed = reduction(
            baseline["successes"],
            candidate["successes"],
            baseline["worker_cost_microusd"],
            candidate["worker_cost_microusd"],
        )
        uncertainty, lower, cost_lower = bootstrap(tasks, request["seed"], observed)
    gates = evaluate_gates(
        request, tasks, complete, full, baseline, candidate, categories, (lower, cost_lower)
    )
    report = {
        "schema_version": 1,
        **{
            key: request[key]
            for key in (
                "experiment_id",
                "baseline_hash",
                "candidate_hash",
                "scope",
                "mode",
                "manifest_digest",
                "roster_digest",
            )
        },
        "policy_version": POLICY,
        "evidence_digest": digest(request),
        "complete": complete and (split == "dev" or full),
        "winner": False,
        "baseline": baseline,
        "candidate": candidate,
        "paired": paired(cells),
        "categories": categories,
        "uncertainty": uncertainty,
        "gates": gates,
    }
    report["report_digest"] = digest(report)
    if not accepts("EvaluationReport", report):
        raise ValueError("invalid comparison result")
    return report
