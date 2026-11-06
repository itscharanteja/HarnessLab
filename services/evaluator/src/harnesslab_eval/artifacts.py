import os
from pathlib import Path

from harnesslab_contracts.internal import InternalError, read_json
from harnesslab_contracts.replay import digest

from .grader import VERSION


def reference_for(run: dict, root: Path | None = None) -> dict:
    pinned = run["manifest"]
    _, split, variant, category, _ = pinned["task_key"].split("/")
    if (
        split not in {"dev", "validation"}
        or (pinned["stage"] == "validate") != (split == "validation")
        or pinned["evaluator_version"] not in {VERSION, "pending"}
        or (pinned["evaluator_version"] == "pending" and pinned["mode"] != "fixture")
    ):
        raise InternalError(422, "invalid_provenance")
    try:
        directory = (root or Path(os.environ["HL_EVALUATOR_ARTIFACT_DIR"])) / split
        manifest = read_json(directory / "manifest.json")
        oracles = read_json(directory / "oracles.json")
    except (KeyError, OSError, ValueError):
        raise InternalError(503, "artifact_unavailable") from None
    try:
        manifest_digest = manifest["manifest_digest"]
        (task,) = [item for item in manifest["tasks"] if item["id"] == pinned["task_key"]]
        (dataset,) = [item for item in manifest["variants"] if item["id"] == variant]
        (oracle,) = [item for item in oracles if item["task_key"] == pinned["task_key"]]
        if (
            manifest_digest != pinned["benchmark_digest"]
            or digest({k: v for k, v in manifest.items() if k != "manifest_digest"})
            != manifest_digest
            or manifest["split"] != split
            or type(manifest["fixture"]) is not bool
            or (split == "validation" and manifest["fixture"] != (pinned["mode"] == "fixture"))
            or digest(oracles) != manifest["reference_bundle_digest"]
            or dataset["rows_digest"] != pinned["dataset_digest"]
            or task["variant_id"] != variant
            or task["category"] != category
            or task["split"] != split
            or task["input_hash"] != pinned["task_input_hash"]
            or oracle["input_hash"] != pinned["task_input_hash"]
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise InternalError(422, "invalid_provenance") from None
    return oracle
