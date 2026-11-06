from decimal import Context, Decimal, DecimalException, localcontext
from unicodedata import normalize

from harnesslab_contracts.internal import private_data
from harnesslab_contracts.replay import digest, trace_digest
from harnesslab_contracts.validate import accepts

VERSION = "phase3-eval-v1"
UNITS = {"usd_cents", "count", "ratio"}
MISSING = object()


def validate_envelope(run: dict):
    if not accepts("RunEnvelope", run) or private_data(run):
        raise ValueError("Invalid envelope")
    manifest = run["manifest"]
    previous_time = 0
    events = run["events"]
    for seq, event in enumerate(events):
        if (
            event["seq"] != seq
            or event["run_id"] != manifest["run_id"]
            or event["elapsed_ms"] < previous_time
            or event["kind"] == "grade"
        ):
            raise ValueError("Invalid event lineage")
        previous_time = event["elapsed_ms"]
    if (
        events[0]["kind"] != "start"
        or events[0]["payload"]
        != {
            "task_key": manifest["task_key"],
            "config_hash": manifest["config_hash"],
        }
        or any(e["kind"] == "start" for e in events[1:])
    ):
        raise ValueError("Invalid start event")
    finals = [event for event in events if event["kind"] == "final_output"]
    if run["answer"] is not None:
        expected_result = {"answer": "answered", "clarify": "clarified", "unable": "unable"}
        if (
            len(finals) != 1
            or finals[0]["payload"] != run["answer"]
            or finals[0]["outcome_code"] != run["result"]
            or finals[0] != events[-1]
            or expected_result[run["answer"]["kind"]] != run["result"]
        ):
            raise ValueError("Invalid final event")
    elif finals or run["result"] in {"answered", "clarified"}:
        raise ValueError("Unexpected final event")
    if trace_digest(events) != run["trace_digest"]:
        raise ValueError("Trace digest mismatch")


def decimal(value):
    if type(value) is int:
        return Decimal(value)
    if accepts("DecimalString", value):
        return Decimal(value)
    return MISSING


def normalized(value, kind, aliases):
    if kind == "integer":
        return value if type(value) is int else MISSING
    if kind == "decimal":
        return decimal(value) if isinstance(value, str) else MISSING
    if kind == "boolean":
        return value if type(value) is bool else MISSING
    if kind == "string" and isinstance(value, str):
        text = normalize("NFC", value)
        return aliases.get(text, text)
    if kind in {"integer_set", "string_set"} and isinstance(value, list):
        items = [normalized(item, kind.removesuffix("_set"), aliases) for item in value]
        if MISSING not in items and len(set(items)) == len(items):
            return tuple(sorted(items))
    return MISSING


def calculation(operation: str, operands: list[tuple[Decimal, str]]):
    values, units = zip(*operands, strict=True)
    unit = units[0]
    with localcontext(Context(prec=38)):
        if operation == "identity" and len(values) == 1:
            return values[0], unit
        if operation == "sum" and len(values) >= 2 and len(set(units)) == 1:
            return sum(values), unit
        if len(values) != 2:
            return None
        if operation == "difference" and units[0] == units[1]:
            return values[0] - values[1], unit
        if operation == "product" and "ratio" in units:
            return values[0] * values[1], units[1] if unit == "ratio" else unit
        if operation == "ratio" and (units[0] == units[1] or units[1] == "ratio"):
            return values[0] / values[1], "ratio" if units[0] == units[1] else unit
    return None


class Ledger:
    def __init__(self, events: list[dict]):
        self.queries: dict[str, dict] = {}
        self.calculations: dict[str, tuple[Decimal, str]] = {}
        requests = {}
        consumed = set()
        calculation_ids = set()
        for event in events:
            key, payload = event["correlation_id"], event["payload"]
            if event["kind"] == "tool_request":
                if key is None or key in requests:
                    raise ValueError("Duplicate tool request")
                requests[key] = payload["call"]
            if event["kind"] != "tool_result":
                continue
            call = requests.get(key)
            if call is None or key in consumed or call["name"] != payload["name"]:
                raise ValueError("Unmatched tool result")
            consumed.add(key)
            if payload["status"] != "ok":
                continue
            data = payload["data"]
            if call["name"] == "execute_readonly_sql":
                query_id = data["query_id"]
                columns, rows = data["columns"], data["rows"]
                if (
                    query_id in self.queries
                    or len({c["name"] for c in columns}) != len(columns)
                    or any(len(row) != len(columns) for row in rows)
                    or digest({"columns": columns, "rows": rows}) != data["payload_hash"]
                ):
                    raise ValueError("Invalid SQL evidence")
                self.queries[query_id] = data
            elif call["name"] == "validate_calculation":
                calculation_id = data["calculation_id"]
                if calculation_id in calculation_ids:
                    raise ValueError("Duplicate calculation")
                calculation_ids.add(calculation_id)
                args = call["arguments"]
                if args["operands"] != data["sources"]:
                    continue
                operands = [
                    self.numeric_ref(item["source"], item["unit"]) for item in data["sources"]
                ]
                if any(item is None for item in operands):
                    continue
                try:
                    result = calculation(args["operation"], operands)
                except DecimalException:
                    continue
                if result == (Decimal(data["value"]), data["unit"]):
                    self.calculations[calculation_id] = result

    def cell(self, ref: dict):
        query = self.queries.get(ref["query_id"])
        if query is None or ref["row"] >= len(query["rows"]):
            return MISSING, None
        for index, column in enumerate(query["columns"]):
            if column["name"] == ref["column"]:
                return query["rows"][ref["row"]][index], column["type"]
        return MISSING, None

    def numeric_ref(self, ref: dict, unit: str):
        if unit not in UNITS:
            return None
        if ref["kind"] == "calculation":
            value = self.calculations.get(ref["calculation_id"])
            return value if value and value[1] == unit else None
        raw, kind = self.cell(ref)
        typed = (kind == "integer" and type(raw) is int) or (
            kind == "decimal" and isinstance(raw, str)
        )
        value = decimal(raw) if typed else MISSING
        return (value, unit) if value is not MISSING else None

    def evidence(self, finding: dict, reference: dict, expected, target) -> bool:
        kind, unit = reference["value_type"], reference["unit"]
        aliases = reference.get("enum_aliases", {})
        values = []
        for ref in finding["evidence"]:
            if ref["kind"] == "calculation":
                resolved = self.numeric_ref(ref, unit)
                if resolved and kind in {"integer", "decimal"}:
                    value = resolved[0]
                    if kind == "integer" and value != value.to_integral_value():
                        continue
                    values.append(value)
                continue
            raw, column = self.cell(ref)
            scalar_kind = kind.removesuffix("_set")
            if column != scalar_kind:
                continue
            value = decimal(raw) if kind == "decimal" else normalized(raw, scalar_kind, aliases)
            if value is not MISSING:
                values.append(value)
        if kind.endswith("_set"):
            return set(expected) <= set(values) and (bool(expected) or bool(values))
        return any(
            equal(value, expected, reference) and equal(value, target, reference)
            for value in values
        )


def equal(value, expected, reference):
    if value is MISSING or expected is MISSING:
        return False
    if reference["value_type"] == "decimal":
        with localcontext(Context(prec=120)):
            return abs(value - expected) <= Decimal(reference["tolerance"])
    return value == expected


def grade_run(run: dict, oracle: dict) -> dict:
    validate_envelope(run)
    if any(
        run["manifest"][manifest_key] != oracle[oracle_key]
        for manifest_key, oracle_key in (
            ("task_key", "task_key"),
            ("task_input_hash", "input_hash"),
        )
    ):
        raise ValueError("Oracle provenance mismatch")
    answer = run["answer"]
    reasons = set()
    if any(
        e["kind"] == "policy_decision" and e["payload"]["safety_violation"] for e in run["events"]
    ):
        reasons.add("unsafe")
    if run["result"] not in {"answered", "clarified"}:
        reasons.add(run["result"])
    elif answer["kind"] != oracle["kind"]:
        reasons.add("wrong_outcome")
    elif answer["kind"] == "clarify":
        if set(answer["missing_fields"]) != set(oracle["missing_fields"]):
            reasons.add("wrong_clarification_fields")
        if any(
            (
                event["kind"] == "tool_request"
                and event["payload"]["call"]["name"] == "execute_readonly_sql"
            )
            or event["outcome_code"] in {"malformed_sql_action", "sql_too_large"}
            for event in run["events"]
        ):
            reasons.add("sql_before_clarification")
    else:
        ledger = Ledger(run["events"])
        expected = {item["key"]: item for item in oracle["findings"]}
        findings = {item["key"]: item for item in answer["findings"]}
        if set(expected) != set(findings) or len(findings) != len(answer["findings"]):
            reasons.add("wrong_finding_keys")
        for key in expected.keys() & findings.keys():
            ref, finding = expected[key], findings[key]
            kind, aliases = ref["value_type"], ref.get("enum_aliases", {})
            value = normalized(finding["value"], kind, aliases)
            target = normalized(ref["value"], kind, aliases)
            if finding["unit"] != ref["unit"]:
                reasons.add("wrong_unit")
            if not equal(value, target, ref):
                reasons.add("wrong_value")
            if value is MISSING or not ledger.evidence(finding, ref, value, target):
                reasons.add("unsupported_evidence")

    grade = {"schema_version": 1, "success": not reasons, "reasons": sorted(reasons)}
    replay_digest = digest(
        {
            "evaluator_version": VERSION,
            "benchmark_digest": run["manifest"]["benchmark_digest"],
            "trace_digest": run["trace_digest"],
            "grade": grade,
        }
    )
    return {"schema_version": 1, "grade": grade, "replay_digest": replay_digest}


def render_answer(answer: dict, labels: dict[str, str]) -> str:
    if answer["kind"] == "clarify":
        return answer["question"]
    if answer["kind"] == "unable":
        return "Unable to answer this task."
    lines = []
    for finding in answer["findings"]:
        label = labels.get(finding["key"], finding["key"].replace("_", " ").capitalize())
        refs = [
            f"{ref['query_id']} row {ref['row']} column {ref['column']}"
            if ref["kind"] == "cell"
            else ref["calculation_id"]
            for ref in finding["evidence"]
        ]
        lines.append(f"{label} — {finding['value']} {finding['unit']} ({', '.join(refs)})")
    if any(item["key"] == "average_receipt_effect" for item in answer["findings"]):
        lines.append("Average receipts per order combine pricing, product mix and payment effects.")
    return "\n".join(lines)
