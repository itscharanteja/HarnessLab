import os
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from scripts.holdout_job import seal_evaluation
from scripts.holdout_ledger import PostgresLedger


def test_isolated_postgres_ledger_serializes_and_preserves_a_sealed_holdout():
    dsn = os.environ.get(
        "HL_HOLDOUT_FIXTURE_ADMIN_DSN",
        "postgresql://hl_holdout_admin:fixture_holdout_admin@127.0.0.1:55434/harnesslab_holdout",
    )
    assert conninfo_to_dict(dsn).get("host") in {"localhost", "127.0.0.1"}
    name = "hl_ledger_" + uuid4().hex[:12]
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute("CREATE ROLE hl_holdout_ledger LOGIN PASSWORD 'fixture_ledger_test'")
        try:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
            try:
                with psycopg.connect(make_conninfo(dsn, dbname=name)) as db:
                    db.execute(Path("infra/cloud-run/holdout-ledger.sql").read_text())
                role = make_conninfo(
                    dsn, dbname=name, user="hl_holdout_ledger", password="fixture_ledger_test"
                )
                digest = "a" * 64
                pin = {"baseline": "a", "candidate": "b"}
                with pytest.raises(ValueError, match="dedicated_holdout_ledger_required"):
                    PostgresLedger(role, name, digest)
                first = PostgresLedger(role, name, digest, require_tls=False)
                try:
                    assert seal_evaluation(first, digest, pin) is None
                    with pytest.raises(ValueError, match="holdout_already_running"):
                        PostgresLedger(role, name, digest, require_tls=False)
                    with first:
                        first.execute(
                            "UPDATE evaluations SET report=? WHERE digest=?", ("{}", digest)
                        )
                finally:
                    first.close()
                second = PostgresLedger(role, name, digest, require_tls=False)
                try:
                    assert seal_evaluation(second, digest, pin) == {}
                    with pytest.raises(ValueError, match="holdout_already_sealed"):
                        seal_evaluation(second, digest, {**pin, "candidate": "c"})
                    with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
                        with second:
                            second.execute(
                                "UPDATE evaluations SET report=? WHERE digest=?", ("[]", digest)
                            )
                finally:
                    second.close()
            finally:
                admin.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(name)))
        finally:
            admin.execute("DROP ROLE hl_holdout_ledger")
