import argparse
import errno
import json
import os
import sys
from pathlib import Path
from secrets import token_hex
from tempfile import TemporaryDirectory

import psycopg

from .data import DATASET, GENERATOR_REVISION, Variant, canonical, digest, generate_rows
from .database import install_variant, load_schema, read_rows, runtime_dsn
from .reference_sql import postgres_reference
from .scenarios import COUNTS, python_reference, reference_record, tasks_for

VARIANT_COUNTS = {"dev": 6, "validation": 3, "holdout": 3}
PREFIX = {"dev": "d", "validation": "v", "holdout": "h"}
ROOT = Path(__file__).resolve().parents[2]
DEV_SEED_REVISION = "synthetic-development-v1"


def fixture_seed_dsn(split: str) -> str:
    if split == "holdout":
        port = os.environ.get("HOLDOUT_DB_PORT", "55434")
        return os.environ.get(
            "HL_FIXTURE_HOLDOUT_SEED_DSN",
            f"postgresql://hl_holdout_seed:fixture_holdout_seed@127.0.0.1:{port}/harnesslab_holdout",
        )
    port = os.environ.get("SANDBOX_DB_PORT", "55433")
    return os.environ.get(
        "SANDBOX_SEED_DSN",
        f"postgresql://hl_seed:fixture_seed@127.0.0.1:{port}/harnesslab_sandbox",
    )


def fixture_variants(split: str) -> tuple[str, list[Variant]]:
    revision = DEV_SEED_REVISION if split == "dev" else f"test-only-{split}-v1"
    return revision, [
        Variant(split, f"{PREFIX[split]}{index:02d}", f"{revision}/{index}")
        for index in range(1, VARIANT_COUNTS[split] + 1)
    ]


def release_variants(split: str, seed_file: Path) -> tuple[str, list[Variant]]:
    if seed_file.resolve().is_relative_to(ROOT):
        raise ValueError("Private seed files must be outside the repository")
    if seed_file.stat().st_mode & 0o077:
        raise ValueError("Private seed files must be readable by the owner only")
    payload = json.loads(seed_file.read_text(encoding="utf-8"))
    if set(payload) != {"seed_revision", "seeds"}:
        raise ValueError("Seed file requires seed_revision and seeds")
    seeds = payload["seeds"]
    revision = payload["seed_revision"]
    if (
        not isinstance(revision, str)
        or not revision.strip()
        or len(revision) > 100
        or not isinstance(seeds, list)
        or len(seeds) != VARIANT_COUNTS[split]
        or any(not isinstance(seed, str) or len(seed.encode("utf-8")) < 16 for seed in seeds)
        or len(set(seeds)) != len(seeds)
    ):
        raise ValueError("Invalid seed revision or variant seed list")
    return revision, [
        Variant(split, f"{PREFIX[split]}{digest([revision, seed])[:12]}", seed) for seed in seeds
    ]


def generator_digest() -> str:
    paths = sorted(Path(__file__).parent.glob("*.py"))
    paths.append(ROOT / "datasets" / "synthetic-business" / "metrics.json")
    return digest({str(path.relative_to(ROOT)): path.read_text(encoding="utf-8") for path in paths})


def build_split(
    variants: list[Variant],
    revision: str,
    dsn: str,
    *,
    fixture: bool,
) -> dict[str, object]:
    split = variants[0].split
    dataset = {variant.key: generate_rows(variant) for variant in variants}
    tasks = tasks_for(variants, dataset)
    references = {}
    with psycopg.connect(dsn, connect_timeout=4, autocommit=True) as conn:
        for variant in variants:
            scratch = f"{variant.schema}_oracle_{token_hex(4)}"
            with conn.transaction(force_rollback=True):
                conn.execute("SET LOCAL TIME ZONE 'UTC'")
                load_schema(conn, variant, scratch, dataset[variant.key])
                if read_rows(conn, variant, scratch) != dataset[variant.key]:
                    raise ValueError("PostgreSQL rows differ from generated data")
                for task in tasks:
                    if task.input["variant_id"] != variant.key:
                        continue
                    values = python_reference(task, dataset[variant.key])
                    if postgres_reference(conn, variant, scratch, task) != values:
                        raise ValueError(
                            f"Independent oracles disagree for {task.input['task_key']}"
                        )
                    references[task.input["task_key"]] = reference_record(task, values)
    prompts = [{"task": task.input, "fault": task.fault} for task in tasks]
    oracles = [references[task.input["task_key"]] for task in tasks]
    tables = [
        {
            "variant_id": variant.key,
            "schema": variant.schema,
            "mapping": variant.mapping,
            "relation_order": list(variant.mapping),
            "column_orders": {
                key: list(details["columns"]) for key, details in variant.mapping.items()
            },
            "rows": dataset[variant.key],
        }
        for variant in variants
    ]
    manifest = {
        "schema_version": 1,
        "dataset_version": DATASET,
        "split": split,
        "fixture": fixture,
        "seed_revision": revision,
        "generator_revision": GENERATOR_REVISION,
        "generator_digest": generator_digest(),
        "reference_bundle_digest": digest(oracles),
        "prompt_bundle_digest": digest(prompts),
        "dataset_bundle_digest": digest(tables),
        "variants": [
            {
                "id": variant.key,
                "schema_revision": DATASET,
                "rows_digest": digest(dataset[variant.key]),
            }
            for variant in variants
        ],
        "tasks": [
            {
                "id": task.input["task_key"],
                "split": split,
                "variant_id": task.input["variant_id"],
                "category": task.input["category"],
                "input_hash": digest(task.input),
                "fault_digest": digest(task.fault),
            }
            for task in tasks
        ],
    }
    manifest["manifest_digest"] = digest(manifest)
    return {"manifest": manifest, "prompts": prompts, "oracles": oracles, "datasets": tables}


def write_private(path: Path, value: object) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
        stream.write(canonical(value) + b"\n")


def publish(destination: Path, split: str, artifacts: dict[str, object]) -> None:
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.stat().st_mode & 0o077:
        raise ValueError("Artifact destination must be accessible by the owner only")
    target = destination / split
    with TemporaryDirectory(dir=destination, prefix=f".{split}-") as work:
        staging = Path(work) / split
        staging.mkdir(mode=0o700)
        for name, content in artifacts.items():
            write_private(staging / f"{name}.json", content)
        try:
            staging.rename(target)
        except OSError as error:
            if error.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                raise
            for name in artifacts:
                entry = f"{name}.json"
                if (staging / entry).read_bytes() != (target / entry).read_bytes():
                    raise ValueError(f"Refusing to overwrite a different {split} bundle") from None


def read_bundle(root: Path, split: str) -> dict[str, object]:
    files = {}
    for name in ("manifest", "prompts", "oracles", "datasets"):
        path = root / split / f"{name}.json"
        files[name] = json.loads(path.read_text(encoding="utf-8"))
    manifest = files["manifest"]
    expected = manifest["manifest_digest"]
    if (
        digest({key: value for key, value in manifest.items() if key != "manifest_digest"})
        != expected
    ):
        raise ValueError("Manifest digest mismatch")
    for key, artifact in (
        ("prompt_bundle_digest", "prompts"),
        ("reference_bundle_digest", "oracles"),
        ("dataset_bundle_digest", "datasets"),
    ):
        if digest(files[artifact]) != manifest[key]:
            raise ValueError(f"Digest mismatch for {artifact}")
    return files


def load_fixture(root: Path, split: str, dsn: str) -> None:
    _, variants = fixture_variants(split)
    bundle = read_bundle(root, split)
    runtime_dir = root / ".runtime"
    runtime_dir.mkdir(mode=0o700, exist_ok=True)
    map_file = runtime_dir / f"{split}.json"
    previous = json.loads(map_file.read_text(encoding="utf-8")) if map_file.is_file() else {}
    roles = {}
    with psycopg.connect(dsn, connect_timeout=4) as conn:
        conn.execute("SET LOCAL TIME ZONE 'UTC'")
        for variant, table in zip(variants, bundle["datasets"], strict=True):
            if table["variant_id"] != variant.key or table["mapping"] != variant.mapping:
                raise ValueError("Unexpected physical variant metadata")
            install_variant(conn, variant, table["rows"])
            roles[variant.key] = runtime_dsn(conn, variant, dsn, previous.get(variant.key))
    with TemporaryDirectory(dir=runtime_dir) as scratch:
        temporary = Path(scratch) / "runtime.json"
        write_private(temporary, roles)
        temporary.replace(map_file)


def verify_fixture(root: Path, split: str, dsn: str) -> None:
    revision, variants = fixture_variants(split)
    bundle = read_bundle(root, split)
    if bundle["manifest"]["seed_revision"] != revision:
        raise ValueError("Fixture seed revision mismatch")
    datasets = {}
    variants_by_key = {variant.key: variant for variant in variants}
    with psycopg.connect(dsn, connect_timeout=4) as conn:
        conn.execute("SET LOCAL TIME ZONE 'UTC'")
        for variant, meta in zip(variants, bundle["manifest"]["variants"], strict=True):
            actual = read_rows(conn, variant, variant.schema)
            if meta["id"] != variant.key or digest(actual) != meta["rows_digest"]:
                raise ValueError("Restored variant checksum mismatch")
            datasets[variant.key] = actual
        for task, prompt, oracle in zip(
            tasks_for(variants, datasets),
            bundle["prompts"],
            bundle["oracles"],
            strict=True,
        ):
            key = task.input["variant_id"]
            variant = variants_by_key[key]
            if prompt != {"task": task.input, "fault": task.fault}:
                raise ValueError("Prompt replay differs from fixture bundle")
            values = postgres_reference(conn, variant, variant.schema, task)
            if (
                reference_record(task, values) != oracle
                or python_reference(task, datasets[key]) != values
            ):
                raise ValueError("Reference replay differs from fixture bundle")


def split_options(mode: str, split: str) -> tuple[str, ...]:
    if split and split not in COUNTS:
        raise ValueError("Unknown benchmark split")
    if mode == "fixture":
        return (split,) if split else tuple(COUNTS)
    if split not in {"validation", "holdout"}:
        raise ValueError("Release generation requires SPLIT=validation or SPLIT=holdout")
    return (split,)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("generate", "seed", "verify"))
    parser.add_argument(
        "--mode", choices=("fixture", "release"), default=os.environ.get("MODE") or "fixture"
    )
    parser.add_argument("--split", default=os.environ.get("SPLIT") or "")
    parser.add_argument("--seed-file", type=Path, default=os.environ.get("SEED_FILE") or None)
    parser.add_argument("--out-dir", type=Path, default=os.environ.get("OUT_DIR") or None)
    args = parser.parse_args()
    try:
        splits = split_options(args.mode, args.split)
        root = (args.out_dir or ROOT / ".artifacts" / "benchmark-fixture").resolve()
        if args.mode == "release":
            if args.command != "generate" or not args.seed_file or not args.out_dir:
                raise ValueError("Release generation requires SEED_FILE and OUT_DIR")
            if root.is_relative_to(ROOT):
                raise ValueError("Release bundles must be written outside the repository")
            if not os.environ.get("SANDBOX_SEED_DSN"):
                raise ValueError("Release generation requires an authorized SANDBOX_SEED_DSN")
        for split in splits:
            if args.mode == "fixture":
                revision, variants = fixture_variants(split)
                dsn = fixture_seed_dsn(split)
            else:
                revision, variants = release_variants(split, args.seed_file)
                dsn = os.environ["SANDBOX_SEED_DSN"]
            if args.command == "generate":
                publish(
                    root,
                    split,
                    build_split(variants, revision, dsn, fixture=args.mode == "fixture"),
                )
            elif args.command == "seed":
                load_fixture(root, split, dsn)
            else:
                verify_fixture(root, split, dsn)
            print(f"{args.command} {args.mode} {split}: {sum(COUNTS[split])} tasks")
    except (ValueError, OSError, psycopg.Error) as error:
        if args.mode == "release":
            print(
                f"Release benchmark {args.command} failed ({type(error).__name__})", file=sys.stderr
            )
        else:
            print(f"Fixture benchmark {args.command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
