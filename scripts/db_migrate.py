import os
from hashlib import sha256
from pathlib import Path

import psycopg
from harnesslab_runner.config import read_harness
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb

MIGRATIONS = Path("packages/control-db/migrations")


def migrate(dsn: str):
    baseline = read_harness(Path("harnesses/baseline.yaml").read_bytes())
    with psycopg.connect(dsn, connect_timeout=4) as db:
        db.execute("SELECT pg_advisory_xact_lock(712036221)")
        db.execute("CREATE SCHEMA IF NOT EXISTS hl_migrations")
        db.execute("""
            CREATE TABLE IF NOT EXISTS hl_migrations.applied (
                name text PRIMARY KEY, sha256 text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )
        """)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            source = path.read_bytes()
            digest = sha256(source).hexdigest()
            found = db.execute(
                "SELECT sha256 FROM hl_migrations.applied WHERE name=%s", (path.name,)
            ).fetchone()
            if found is None:
                db.execute(source.decode())
                db.execute(
                    "INSERT INTO hl_migrations.applied (name,sha256) VALUES (%s,%s)",
                    (path.name, digest),
                )
            elif found[0] != digest:
                raise ValueError("Applied migration checksum mismatch")
        db.execute(
            """INSERT INTO hl.harness_versions(content_sha256,config,canonical_json,yaml_bytes)
               VALUES (%s,%s,%s,%s) ON CONFLICT (content_sha256) DO NOTHING""",
            (
                baseline.content_hash,
                Jsonb(baseline.config),
                baseline.canonical,
                baseline.yaml_bytes,
            ),
        )
        channel = "fixture" if os.environ.get("MODE", "fixture") == "fixture" else "production"
        db.execute(
            """INSERT INTO hl.harness_channels(channel,active_version_id)
               SELECT %s,id FROM hl.harness_versions WHERE content_sha256=%s
               ON CONFLICT (channel) DO NOTHING""",
            (channel, baseline.content_hash),
        )


def main():
    dsn = os.environ.get("CONTROL_MIGRATOR_DSN")
    mode = os.environ.get("MODE", "fixture")
    if mode not in {"fixture", "release"}:
        raise SystemExit("Use MODE=fixture or MODE=release")
    fixture = mode == "fixture"
    if fixture and not dsn:
        port = int(os.environ.get("CONTROL_DB_PORT", "55432"))
        dsn = f"postgresql://hl_migrator:fixture_migrator@127.0.0.1:{port}/harnesslab_control"
    if not dsn:
        raise SystemExit("Set CONTROL_MIGRATOR_DSN for the authorized database")
    if fixture and conninfo_to_dict(dsn).get("host") not in {
        "localhost",
        "127.0.0.1",
        "control-db",
    }:
        raise SystemExit("Fixture migrations require a local control database")
    try:
        migrate(dsn)
    except (psycopg.Error, OSError, ValueError) as exc:
        raise SystemExit(f"Control migration failed ({type(exc).__name__})") from None
    print("Control migrations applied and baseline verified")


if __name__ == "__main__":
    main()
